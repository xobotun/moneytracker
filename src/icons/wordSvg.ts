import { iconColourOn } from './colours'
import { CAP_HEIGHTS, textWidthEm } from './fontMetrics'

// A word as an icon (docs/plans/2026-10-28-icons-design.md §2–3): the Text
// tab's settings make an SVG — a circle of the background colour with the
// text centred on it, sized to fit — stored as an image whose `source` keeps
// the settings. Everything here is a pure function of the settings: two
// devices making the same word write the same text, hence the same image row.

export type WordFont = 'sans' | 'serif' | 'mono' | 'condensed'

export interface WordSettings {
  text: string
  font: WordFont
  bold: boolean
  /** The text's colour, '#rrggbb'. */
  colour: string
  /** The circle's colour, '#rrggbb'. */
  background: string
}

export interface WordFontInfo {
  id: WordFont
  label: string
  /** System fonts only: nothing is downloaded, so each device uses its own look-alike. */
  family: string
  stretch?: 'condensed'
}

export const WORD_FONTS: readonly WordFontInfo[] = [
  { id: 'sans', label: 'Sans', family: "Helvetica, Arial, 'Liberation Sans', sans-serif" },
  {
    id: 'serif',
    label: 'Serif',
    family: "'Times New Roman', Times, 'Liberation Serif', serif",
  },
  {
    id: 'mono',
    label: 'Mono',
    family: "Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
  {
    id: 'condensed',
    label: 'Condensed',
    family:
      "'Arial Narrow', 'Liberation Sans Narrow', 'Roboto Condensed', sans-serif-condensed, 'Helvetica Neue', sans-serif",
    stretch: 'condensed',
  },
]

const FONTS = new Map(WORD_FONTS.map((font) => [font.id, font]))

/** Up to about six characters read well at badge size; a little more still fits. */
export const WORD_MAX_LENGTH = 8

/** The picture's size: a 256 × 256 viewBox. */
export const WORD_SIZE = 256
const CENTRE = WORD_SIZE / 2
/** The text's box stays inside this radius, clear of the circle's edge. */
const FIT_RADIUS = 108
/** A single letter would fill the circle; it stops at this size. */
const MAX_FONT_SIZE = 140
/** Room below the capitals for descenders (g, p, y), in em. */
const DESCENDER_ROOM = 0.1

const HEX = /^#[0-9a-f]{6}$/

/** '#ABC' or '#aabbcc' → '#aabbcc'; anything else is null. */
export function normaliseHex(colour: string): string | null {
  const c = colour.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c.slice(1).replace(/./g, '$&$&')}`
  return HEX.test(c) ? c : null
}

/** The text as drawn: no control characters, runs of white space as one space, trimmed. */
export function wordText(text: string): string {
  return text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A new word: the owner's colour as its background, white or black text on it. */
export function defaultWord(ownerColour: string): WordSettings {
  const background = normaliseHex(ownerColour) ?? '#6b7280'
  return { text: '', font: 'sans', bold: true, colour: iconColourOn(background), background }
}

/**
 * The settings as stored in the image's `source`: keys sorted, text
 * normalised, colours lower-case, so the same word is always the same JSON.
 */
export function wordSource(settings: WordSettings): Record<string, unknown> {
  return {
    background: normaliseHex(settings.background) ?? settings.background,
    bold: settings.bold,
    colour: normaliseHex(settings.colour) ?? settings.colour,
    font: settings.font,
    text: wordText(settings.text),
  }
}

/**
 * The settings a stored `source` holds, or null when it is not a word this
 * build can edit (a field missing or of another type, an unknown font — say
 * from a newer app).
 */
export function wordFromSource(source: Record<string, unknown> | null): WordSettings | null {
  if (source === null) return null
  const { text, font, bold, colour, background } = source
  if (typeof text !== 'string' || wordText(text) === '') return null
  if (typeof font !== 'string' || !FONTS.has(font as WordFont)) return null
  if (typeof bold !== 'boolean') return null
  if (typeof colour !== 'string' || typeof background !== 'string') return null
  const c = normaliseHex(colour)
  const b = normaliseHex(background)
  if (c === null || b === null) return null
  return { text: wordText(text), font: font as WordFont, bold, colour: c, background: b }
}

/** Text content escaped the way XMLSerializer writes it. */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Where the text goes: font size, its left end, baseline and length, all whole pixels. */
export interface WordLayout {
  fontSize: number
  x: number
  y: number
  textLength: number
}

/**
 * Sizes the text to fit the circle: the box from its capitals' top to a
 * little below the baseline, as wide as the font's metrics say, has its
 * corners on a circle of FIT_RADIUS. `textLength` pins the drawn width to
 * that estimate, so a device whose look-alike font is wider squeezes it
 * rather than letting it spill over the edge.
 */
export function wordLayout(text: string, font: WordFont, bold: boolean): WordLayout {
  const width = textWidthEm(text, font, bold)
  const cap = CAP_HEIGHTS[font] / 1000
  const halfHeight = cap / 2 + DESCENDER_ROOM
  const fitting = FIT_RADIUS / Math.hypot(width / 2, halfHeight)
  const fontSize = Math.floor(Math.min(MAX_FONT_SIZE, fitting))
  const textLength = Math.round(width * fontSize)
  return {
    fontSize,
    x: Math.round((WORD_SIZE - textLength) / 2),
    y: Math.round(CENTRE + (cap * fontSize) / 2),
    textLength,
  }
}

/**
 * The word's SVG. Written exactly as the SVG cleaner (svgClean.ts) serialises
 * it, so cleaning it changes nothing. Colours must be '#rrggbb' (anything
 * else is replaced by black text on grey); the text is escaped.
 */
export function wordSvg(settings: WordSettings): string {
  const font = FONTS.get(settings.font) ?? WORD_FONTS[0]!
  const colour = normaliseHex(settings.colour) ?? '#000000'
  const background = normaliseHex(settings.background) ?? '#6b7280'
  const text = wordText(settings.text)
  const circle = `<circle cx="${CENTRE}" cy="${CENTRE}" r="${CENTRE}" fill="${background}"/>`
  let label = ''
  if (text !== '') {
    const at = wordLayout(text, font.id, settings.bold)
    const attributes = [
      `x="${at.x}"`,
      `y="${at.y}"`,
      `font-family="${font.family}"`,
      `font-size="${at.fontSize}"`,
      settings.bold ? 'font-weight="bold"' : null,
      font.stretch ? `font-stretch="${font.stretch}"` : null,
      `fill="${colour}"`,
      `textLength="${at.textLength}"`,
      'lengthAdjust="spacingAndGlyphs"',
    ]
    label = `<text ${attributes.filter((a) => a !== null).join(' ')}>${escapeText(text)}</text>`
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WORD_SIZE} ${WORD_SIZE}" ` +
    `width="${WORD_SIZE}" height="${WORD_SIZE}">${circle}${label}</svg>`
  )
}
