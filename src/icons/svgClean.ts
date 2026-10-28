import DOMPurify from 'dompurify'

// Cleans an SVG before it is stored (docs/plans/2026-10-28-icons-design.md
// §3). An image is only ever drawn as an <img>, where browsers run no scripts
// and load nothing; cleaning is the second wall, and keeps what syncs to
// every device small and inert: no scripts, event handlers or
// foreignObject (DOMPurify's SVG profile), and no reference outside the
// picture — an href or url(…) must point at an #id inside it or be an
// embedded raster image. Loaded lazily, with the Text and Image tabs.

export const SVG_NS = 'http://www.w3.org/2000/svg'

/** The cleaned markup and the size its viewBox gives. */
export interface CleanSvg {
  content: string
  width: number
  height: number
}

/** A file that cannot be stored as an SVG image; the message is for the user. */
export class SvgError extends Error {}

/** A reference inside the picture, or an embedded raster image. */
const LOCAL_OR_RASTER = /^(?:#|data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,])/i
const URL_FUNCTION = /url\(\s*(['"]?)(.*?)\1\s*\)/gi
const IMPORT_RULE = /@import[^;]*;?/gi
const HREF_ATTRIBUTES = new Set(['href', 'xlink:href'])

/**
 * CSS with every url(…) that leaves the picture replaced by `none` and
 * @import rules removed. Null when it holds a backslash: a CSS escape could
 * spell url( so that no pattern sees it.
 */
export function scrubCss(css: string): string | null {
  if (css.includes('\\')) return null
  return css
    .replace(IMPORT_RULE, '')
    .replace(URL_FUNCTION, (whole: string, _quote: string, target: string) =>
      LOCAL_OR_RASTER.test(target.trim()) ? whole : 'none',
    )
}

// An instance of our own, so these hooks touch no one else's DOMPurify.
const purify = DOMPurify()

purify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'style') {
    const css = scrubCss(node.textContent ?? '')
    node.textContent = css ?? ''
  }
})

purify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (HREF_ATTRIBUTES.has(data.attrName)) {
    // A <use> may only point inside the picture: an embedded image there could be a whole document.
    const allowed = _node.nodeName.toLowerCase() === 'use' ? /^#/ : LOCAL_OR_RASTER
    if (!allowed.test(data.attrValue.trim())) data.keepAttr = false
    return
  }
  if (/url\s*\(|@import|\\/i.test(data.attrValue)) {
    const css = scrubCss(data.attrValue)
    if (css === null) data.keepAttr = false
    else data.attrValue = css
  }
})

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'

/** Removes comments and namespace declarations (the serialiser writes the ones it needs). */
function tidy(root: Element): void {
  const comments: Node[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
  while (walker.nextNode()) comments.push(walker.currentNode)
  for (const comment of comments) comment.parentNode?.removeChild(comment)
  for (const element of [root, ...root.querySelectorAll('*')]) {
    // A copy: removing an attribute changes the live list.
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.namespaceURI === XMLNS_NS || attribute.name === 'xmlns') {
        element.removeAttributeNode(attribute)
      }
    }
  }
}

/** A plain length in pixels ('24', '24px', '1.5e1'); null for %, em and the like. */
function pixels(value: string | null): number | null {
  if (value === null) return null
  const m = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(value)
  if (!m) return null
  const n = Number(m[1])
  return n > 0 && Number.isFinite(n) ? n : null
}

function viewBoxSize(value: string | null): { width: number; height: number } | null {
  if (value === null) return null
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [, , width, height] = parts as [number, number, number, number]
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * Cleans `markup` and makes sure it scales: an SVG without a viewBox gets
 * one from its width and height. Throws an SvgError when the result has no
 * <svg> root or no size to scale from.
 */
export function cleanSvg(markup: string): CleanSvg {
  const fragment = purify.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    FORBID_TAGS: ['foreignObject', 'script'],
    RETURN_DOM_FRAGMENT: true,
  })
  const roots = [...fragment.children]
  const svg = roots.length === 1 ? roots[0]! : null
  if (svg === null || svg.namespaceURI !== SVG_NS || svg.localName !== 'svg') {
    throw new SvgError('This file is not an SVG image.')
  }
  tidy(svg)

  let size = viewBoxSize(svg.getAttribute('viewBox'))
  if (size === null) {
    const width = pixels(svg.getAttribute('width'))
    const height = pixels(svg.getAttribute('height'))
    if (width === null || height === null) {
      throw new SvgError(
        'This SVG has no size to scale from: it needs a viewBox, or a width and height.',
      )
    }
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    size = { width, height }
  }
  return {
    content: new XMLSerializer().serializeToString(svg),
    width: Math.max(1, Math.round(size.width)),
    height: Math.max(1, Math.round(size.height)),
  }
}
