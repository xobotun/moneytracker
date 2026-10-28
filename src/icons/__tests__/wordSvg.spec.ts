import { describe, it, expect } from 'vitest'
import { charWidth, textWidthEm } from '../fontMetrics'
import {
  WORD_FONTS,
  defaultWord,
  normaliseHex,
  wordFromSource,
  wordLayout,
  wordSource,
  wordSvg,
  wordText,
  type WordSettings,
} from '../wordSvg'

const word = (over: Partial<WordSettings> = {}): WordSettings => ({
  text: 'C&A',
  font: 'sans',
  bold: true,
  colour: '#ffffff',
  background: '#e30613',
  ...over,
})

/** The SVG parsed as the image loader parses it: as XML. */
function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
  return doc
}

describe('font metrics', () => {
  it('knows the standard widths of ASCII', () => {
    expect(charWidth('C', 'sans', true)).toBe(722)
    expect(charWidth('i', 'sans', false)).toBe(222)
    expect(charWidth('W', 'serif', true)).toBe(1000)
    expect(charWidth('x', 'mono', false)).toBe(600)
    expect(textWidthEm('C&A', 'sans', true)).toBeCloseTo(2.166)
  })

  it('estimates the rest: accents as their letter, marks as nothing, wide as an em', () => {
    expect(charWidth('É', 'serif', false)).toBe(charWidth('E', 'serif', false))
    expect(charWidth('́', 'sans', false)).toBe(0)
    expect(charWidth('東', 'sans', false)).toBe(1000)
    expect(charWidth('🛒', 'sans', false)).toBe(1000)
    // Armenian: capitals as an H, small letters as an n.
    expect(charWidth('Ս', 'serif', false)).toBe(charWidth('H', 'serif', false))
    expect(charWidth('ս', 'serif', false)).toBe(charWidth('n', 'serif', false))
  })
})

describe('wordSvg', () => {
  it('draws a circle of the background with the text in its colour and font', () => {
    const doc = parse(wordSvg(word({ font: 'serif' })))
    const svg = doc.documentElement
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 256')
    expect(doc.querySelector('circle')!.getAttribute('fill')).toBe('#e30613')
    const text = doc.querySelector('text')!
    expect(text.textContent).toBe('C&A')
    expect(text.getAttribute('fill')).toBe('#ffffff')
    expect(text.getAttribute('font-family')).toBe(WORD_FONTS[1]!.family)
    expect(text.getAttribute('font-weight')).toBe('bold')
    expect(text.getAttribute('lengthAdjust')).toBe('spacingAndGlyphs')
  })

  it('escapes the text: markup, ampersands and quotes stay text', () => {
    const tricky = `<b>"x" & 'y'</b>`
    const svg = wordSvg(word({ text: tricky }))
    expect(svg).toContain('&lt;b&gt;"x" &amp; \'y\'&lt;/b&gt;')
    expect(svg).not.toContain('<b>')
    const doc = parse(svg)
    expect(doc.querySelectorAll('text')).toHaveLength(1)
    expect(doc.querySelector('text')!.textContent).toBe(tricky)
    expect(doc.querySelector('b')).toBeNull()
    // Quotes cannot leave the text either: it has only the attributes we wrote.
    expect([...doc.querySelector('text')!.attributes].map((a) => a.name)).toEqual([
      'x',
      'y',
      'font-family',
      'font-size',
      'font-weight',
      'fill',
      'textLength',
      'lengthAdjust',
    ])
  })

  it('is the same text every time for the same settings', () => {
    expect(wordSvg(word())).toBe(wordSvg(word()))
    expect(wordSvg(word({ colour: '#FFF', text: '  C&A ' }))).toBe(wordSvg(word()))
    expect(wordSvg(word({ bold: false }))).not.toBe(wordSvg(word()))
  })

  it('marks a condensed word as condensed', () => {
    const text = parse(wordSvg(word({ font: 'condensed' }))).querySelector('text')!
    expect(text.getAttribute('font-stretch')).toBe('condensed')
  })

  it('draws only the circle while there is no text', () => {
    const doc = parse(wordSvg(word({ text: '   ' })))
    expect(doc.querySelector('text')).toBeNull()
    expect(doc.querySelector('circle')).not.toBeNull()
  })

  it('replaces colours that are not hex', () => {
    const svg = wordSvg(word({ colour: 'red" onload="x', background: 'url(#a)' }))
    expect(svg).not.toContain('onload')
    expect(parse(svg).querySelector('text')!.getAttribute('fill')).toBe('#000000')
  })
})

describe('wordLayout', () => {
  /** The text box's farthest corner from the centre, in pixels. */
  function reach(text: string, font: WordSettings['font'], bold: boolean): number {
    const at = wordLayout(text, font, bold)
    const capTop = at.y - at.fontSize * (font === 'serif' ? 0.662 : 0.717)
    const bottom = at.y + at.fontSize * 0.1
    const half = at.textLength / 2
    return Math.max(Math.hypot(half, 128 - capTop), Math.hypot(half, bottom - 128))
  }

  it('keeps words of every length and font inside the circle', () => {
    for (const font of ['sans', 'serif', 'mono', 'condensed'] as const) {
      for (const text of ['A', 'C&A', 'SAS', 'Rewe', 'EDEKA', 'Amazon', 'WWWWWWWW', 'Ս Ա Ս']) {
        expect(reach(text, font, true)).toBeLessThan(118)
        const at = wordLayout(text, font, true)
        expect(at.x).toBeGreaterThan(0)
        expect(at.x + at.textLength).toBeLessThan(256)
      }
    }
  })

  it('centres the text and pins its length to the measured width', () => {
    const at = wordLayout('C&A', 'sans', true)
    expect(at.fontSize).toBe(91)
    expect(at.textLength).toBe(Math.round(2.166 * 91))
    expect(Math.abs(at.x * 2 + at.textLength - 256)).toBeLessThanOrEqual(1)
    expect(at.y).toBe(Math.round(128 + (0.717 * 91) / 2))
  })

  it('shrinks longer words and stops a single letter from filling the circle', () => {
    expect(wordLayout('A', 'sans', false).fontSize).toBe(140)
    expect(wordLayout('Amazon', 'sans', false).fontSize).toBeLessThan(
      wordLayout('SAS', 'sans', false).fontSize,
    )
  })

  it('uses whole pixels only', () => {
    for (const value of Object.values(wordLayout('Edeka', 'serif', false))) {
      expect(Number.isInteger(value)).toBe(true)
    }
  })
})

describe('word settings', () => {
  it('stores the settings with sorted keys, normalised', () => {
    const source = wordSource(word({ text: ' C&A  ', colour: '#FFF', background: '#E30613' }))
    expect(JSON.stringify(source)).toBe(
      '{"background":"#e30613","bold":true,"colour":"#ffffff","font":"sans","text":"C&A"}',
    )
  })

  it('reads back what it stored', () => {
    expect(wordFromSource(wordSource(word()))).toEqual(word())
  })

  it('refuses a source it cannot edit', () => {
    expect(wordFromSource(null)).toBeNull()
    expect(wordFromSource({ ...wordSource(word()), font: 'fraktur' })).toBeNull()
    expect(wordFromSource({ ...wordSource(word()), bold: 'yes' })).toBeNull()
    expect(wordFromSource({ ...wordSource(word()), text: ' ' })).toBeNull()
    expect(wordFromSource({ ...wordSource(word()), colour: 'red' })).toBeNull()
    const { background: _, ...noBackground } = wordSource(word())
    expect(wordFromSource(noBackground)).toBeNull()
  })

  it('starts a new word on the owner’s colour with readable text', () => {
    expect(defaultWord('#FDE047')).toMatchObject({ background: '#fde047', colour: '#111827' })
    expect(defaultWord('#1d4ed8')).toMatchObject({ background: '#1d4ed8', colour: '#ffffff' })
    expect(defaultWord('not a colour').background).toBe('#6b7280')
  })

  it('normalises colours and text', () => {
    expect(normaliseHex('#ABC')).toBe('#aabbcc')
    expect(normaliseHex(' #A0B1C2 ')).toBe('#a0b1c2')
    expect(normaliseHex('blue')).toBeNull()
    expect(wordText(' a \t\n b\u0000c ')).toBe('a b c')
  })
})
