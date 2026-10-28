import { describe, it, expect } from 'vitest'
import { SvgError, cleanSvg, scrubCss } from '../svgClean'
import { wordSvg } from '../wordSvg'

const NS = 'xmlns="http://www.w3.org/2000/svg"'

/** Cleans and parses the result as the image loader does: as XML. */
function clean(markup: string): { svg: string; doc: Document } {
  const { content } = cleanSvg(markup)
  const doc = new DOMParser().parseFromString(content, 'image/svg+xml')
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
  return { svg: content, doc }
}

describe('cleanSvg', () => {
  it('removes scripts, event handlers and foreignObject', () => {
    const { svg, doc } = clean(
      `<svg ${NS} viewBox="0 0 10 10" onload="alert(1)">` +
        '<script>alert(2)</script>' +
        '<circle r="5" onclick="alert(3)" fill="red"/>' +
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>' +
        '<a href="javascript:alert(4)"><rect width="1" height="1"/></a>' +
        '</svg>',
    )
    expect(svg).not.toMatch(/script|alert|onload|onclick|foreignObject/i)
    expect(doc.querySelector('circle')!.getAttribute('fill')).toBe('red')
    expect(doc.querySelector('rect')).not.toBeNull()
  })

  it('removes references outside the picture, keeps the ones inside it', () => {
    const { doc } = clean(
      `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">` +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>' +
        '<path id="p" d="M0 0h1"/></defs>' +
        '<rect id="local" width="5" height="5" fill="url(#g)"/>' +
        '<rect id="remote" width="5" height="5" fill="url(https://evil.example/x.svg#g)"/>' +
        '<image id="far" href="https://evil.example/pixel.png" width="1" height="1"/>' +
        '<image id="far2" xlink:href="http://evil.example/pixel.png" width="1" height="1"/>' +
        '<image id="near" href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>' +
        '<use id="u1" href="#p"/>' +
        '<use id="u2" href="https://evil.example/sprite.svg#p"/>' +
        '<use id="u3" href="data:image/svg+xml,&lt;svg/&gt;"/>' +
        '</svg>',
    )
    expect(doc.getElementById('local')!.getAttribute('fill')).toBe('url(#g)')
    expect(doc.getElementById('remote')!.getAttribute('fill')).toBe('none')
    expect(doc.getElementById('far')!.hasAttribute('href')).toBe(false)
    expect(
      doc.getElementById('far2')!.getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
    ).toBeNull()
    expect(doc.getElementById('near')!.getAttribute('href')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    )
    expect(doc.getElementById('u1')!.getAttribute('href')).toBe('#p')
    expect(doc.getElementById('u2')!.hasAttribute('href')).toBe(false)
    expect(doc.getElementById('u3')!.hasAttribute('href')).toBe(false)
  })

  it('keeps a local xlink:href working', () => {
    const { doc } = clean(
      `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">` +
        '<path id="p" d="M0 0h1"/><use id="u" xlink:href="#p"/></svg>',
    )
    expect(doc.getElementById('u')!.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe(
      '#p',
    )
  })

  it('scrubs url(…) in style attributes and style sheets', () => {
    const { svg, doc } = clean(
      `<svg ${NS} viewBox="0 0 10 10">` +
        '<style>@import url(https://evil.example/a.css); .a{fill:url(#g)} .b{fill:url("http://evil.example/x")}</style>' +
        '<rect class="a" width="1" height="1" style="fill:url(#g);stroke:url(http://evil.example/s)"/>' +
        '<rect id="escaped" width="1" height="1" style="fill:u\\72l(http://evil.example/s)"/>' +
        '</svg>',
    )
    expect(svg).not.toContain('evil.example')
    expect(svg).not.toContain('@import')
    expect(doc.querySelector('style')!.textContent).toContain('.a{fill:url(#g)}')
    expect(doc.querySelector('rect')!.getAttribute('style')).toBe('fill:url(#g);stroke:none')
    expect(doc.getElementById('escaped')!.hasAttribute('style')).toBe(false)
  })

  it('adds a viewBox from the width and height, and reports the size', () => {
    const { doc } = clean(
      `<svg ${NS} width="48px" height="24"><rect width="48" height="24"/></svg>`,
    )
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 48 24')
    expect(cleanSvg(`<svg ${NS} width="48px" height="24"/>`)).toMatchObject({
      width: 48,
      height: 24,
    })
    expect(cleanSvg(`<svg ${NS} viewBox="0 0 24.4 10.6"/>`)).toMatchObject({
      width: 24,
      height: 11,
    })
  })

  it('refuses an SVG with no size to scale from', () => {
    expect(() => cleanSvg(`<svg ${NS} width="100%"><rect/></svg>`)).toThrow(SvgError)
  })

  it('refuses what is not an SVG', () => {
    for (const markup of [
      'hello',
      '<p>just text</p>',
      '<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<script>alert(1)</script>',
      '',
      '{"kind":"svg"}',
    ]) {
      expect(() => cleanSvg(markup), markup).toThrow('This file is not an SVG image.')
    }
  })

  it('reads a file with an XML declaration, a doctype and comments', () => {
    const { svg } = clean(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        `<!-- made by hand --><svg ${NS} viewBox="0 0 1 1"><!-- inner --><rect width="1" height="1"/></svg>\n`,
    )
    expect(svg).toBe(`<svg ${NS} viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`)
  })

  it('leaves a word’s SVG as it is, so a word’s id does not depend on the cleaning', () => {
    for (const text of ['C&A', '<b>"x"</b>', 'Ս Ա Ս', 'a > b']) {
      for (const font of ['sans', 'serif', 'mono', 'condensed'] as const) {
        const svg = wordSvg({
          text,
          font,
          bold: font === 'serif',
          colour: '#fff',
          background: '#123456',
        })
        expect(cleanSvg(svg)).toEqual({ content: svg, width: 256, height: 256 })
      }
    }
  })
})

describe('scrubCss', () => {
  it('keeps local and embedded-raster urls, drops the rest and @import', () => {
    expect(scrubCss("fill: url( '#a' )")).toBe("fill: url( '#a' )")
    expect(scrubCss('background:url(data:image/png;base64,AAA=)')).toBe(
      'background:url(data:image/png;base64,AAA=)',
    )
    expect(scrubCss('background:url(data:image/svg+xml,<svg/>)')).toBe('background:none')
    expect(scrubCss('fill:URL(//evil.example/x)')).toBe('fill:none')
    expect(scrubCss('@import "x.css"; a{}')).toBe(' a{}')
    expect(scrubCss('a{fill:\\75rl(x)}')).toBeNull()
  })
})
