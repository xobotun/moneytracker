// Advance widths of printable ASCII (U+0020 … U+007E), in 1/1000 em, for the
// fonts the word icons ask for first (src/icons/wordSvg.ts). Measured once in
// a browser; they are the standard metrics, shared by the look-alikes other
// systems fall back to (Arial and Liberation Sans for Helvetica, Times New
// Roman and Liberation Serif for Times, Liberation Sans Narrow for Arial
// Narrow). A word's size comes from these numbers, never from the device's
// fonts, so the same word makes the same picture — and the same image row —
// on every device.

const unpack = (widths: string): readonly number[] => widths.split(' ').map(Number)

/** Helvetica / Arial, regular and bold. */
const SANS = unpack(
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584',
)
const SANS_BOLD = unpack(
  '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584',
)
/** Times / Times New Roman, regular and bold. */
const SERIF = unpack(
  '250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500 500 500 500 500 500 500 500 500 500 278 278 564 564 564 444 921 722 667 667 722 611 556 722 722 333 389 722 611 889 722 722 556 722 667 556 611 722 722 944 722 722 611 333 278 333 469 500 333 444 500 444 500 444 333 500 500 278 278 500 278 778 500 500 500 500 333 389 278 500 500 722 500 500 444 480 200 480 541',
)
const SERIF_BOLD = unpack(
  '250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 500 500 500 333 333 570 570 570 500 930 722 667 722 722 667 611 778 778 389 500 778 667 944 722 778 611 778 722 556 667 722 722 1000 722 722 667 333 278 333 581 500 333 500 556 444 556 444 333 500 556 278 333 556 278 833 556 500 556 556 444 389 333 556 500 722 500 500 444 394 220 394 520',
)
/** Arial Narrow, regular and bold. */
const CONDENSED = unpack(
  '228 228 291 456 456 729 547 157 273 273 319 479 228 273 228 228 456 456 456 456 456 456 456 456 456 456 228 228 479 479 479 456 832 547 547 592 592 547 501 638 592 228 410 547 456 683 592 638 547 638 592 547 501 592 547 774 547 547 501 228 228 228 385 456 273 456 456 410 456 456 228 456 456 182 182 410 182 683 456 456 456 456 273 410 228 456 410 592 410 410 410 274 213 274 479',
)
const CONDENSED_BOLD = unpack(
  '228 273 389 456 456 729 592 195 273 273 319 479 228 273 228 228 456 456 456 456 456 456 456 456 456 456 273 273 479 479 479 501 800 592 592 592 592 547 501 638 592 228 456 592 501 683 592 638 547 638 592 547 501 592 547 774 547 547 501 273 228 273 479 456 273 456 501 456 501 456 273 501 501 228 228 456 228 729 501 501 501 501 319 456 273 501 456 638 456 456 410 319 230 319 479',
)
/** Menlo, Courier and the other monospaced fonts: every character the same. */
const MONO = Array<number>(95).fill(600)

export type MetricsFont = 'sans' | 'serif' | 'mono' | 'condensed'

const TABLES: Record<MetricsFont, { regular: readonly number[]; bold: readonly number[] }> = {
  sans: { regular: SANS, bold: SANS_BOLD },
  serif: { regular: SERIF, bold: SERIF_BOLD },
  mono: { regular: MONO, bold: MONO },
  condensed: { regular: CONDENSED, bold: CONDENSED_BOLD },
}

/** Height of a capital letter, in 1/1000 em: the text is centred on its capitals. */
export const CAP_HEIGHTS: Record<MetricsFont, number> = {
  sans: 717,
  serif: 662,
  mono: 729,
  condensed: 716,
}

const ascii = (table: readonly number[], ch: string): number | undefined => {
  const code = ch.codePointAt(0)!
  return code >= 0x20 && code <= 0x7e ? table[code - 0x20] : undefined
}

/** CJK, Hangul, full-width forms and emoji take a whole em. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/**
 * The width of one character in 1/1000 em. Outside ASCII it is an estimate:
 * an accented letter is as wide as its base letter, a combining mark adds
 * nothing, a wide character is an em, any other letter is an H (capital) or
 * an n (small).
 */
export function charWidth(ch: string, font: MetricsFont, bold: boolean): number {
  const table = TABLES[font][bold ? 'bold' : 'regular']
  const exact = ascii(table, ch)
  if (exact !== undefined) return exact
  if (/^\p{M}$/u.test(ch)) return 0
  const base = ascii(table, ch.normalize('NFD').charAt(0))
  if (base !== undefined) return base
  if (isWide(ch.codePointAt(0)!)) return 1000
  return ascii(table, ch === ch.toLowerCase() ? 'n' : 'H')!
}

/** The width of `text` in em. */
export function textWidthEm(text: string, font: MetricsFont, bold: boolean): number {
  let total = 0
  for (const ch of text) total += charWidth(ch, font, bold)
  return total / 1000
}
