// A group's block background: the group's hue at the lightness the neutral
// block had, one shade per theme. Derived, never stored or picked.
//
// Lightness and chroma are worked in OKLCH, where equal L looks equally
// bright across hues (conversion: Björn Ottosson's OKLab, sRGB D65).

/** OKLCH L of the neutral light block, Tailwind gray-100. */
export const LIGHT_TINT_LIGHTNESS = 0.967
/** OKLCH L of the neutral dark block: 5 % white over the dark card (#18181b). */
export const DARK_TINT_LIGHTNESS = 0.26
/** Enough colour to read the hue, little enough to stay a background. */
const TINT_CHROMA = 0.03

export interface Oklch {
  l: number
  c: number
  h: number // degrees
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

export function hexToOklch(hex: string): Oklch | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const digits = m[1]!.length === 3 ? [...m[1]!].map((d) => d + d).join('') : m[1]!
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(digits.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
}

/** Linear sRGB channels of an OKLCH colour; outside [0, 1] when out of gamut. */
function oklchToLinearRgb({ l: L, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180)
  const B = c * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6)

/**
 * Near white or black, sRGB holds little chroma for some hues (blue, red),
 * and clipping the channels would shift hue and lightness. Lower the chroma
 * instead, keeping L and h, to the most that fits — CSS Color 4's approach.
 */
function oklchToHex(colour: Oklch): string {
  let rgb = oklchToLinearRgb(colour)
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = colour.c
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklchToLinearRgb({ ...colour, c: mid }))) lo = mid
      else hi = mid
    }
    rgb = oklchToLinearRgb({ ...colour, c: lo })
  }
  return (
    '#' +
    rgb
      .map((v) => Math.round(Math.min(Math.max(toGamma(v), 0), 1) * 255))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

/**
 * `colour`'s hue at OKLCH `lightness`, with at most `chroma`: a grey colour
 * stays grey, the tint never has more chroma than the colour itself. Not a
 * colour (e.g. `currentColor`): a neutral grey of that lightness.
 */
export function tint(colour: string, lightness: number, chroma: number): string {
  const source = hexToOklch(colour) ?? { l: 0.5, c: 0, h: 0 }
  return oklchToHex({ l: lightness, c: Math.min(chroma, source.c), h: source.h })
}

/** Background shades for a group block in the light and dark theme. */
export function groupTints(colour: string): { light: string; dark: string } {
  return {
    light: tint(colour, LIGHT_TINT_LIGHTNESS, TINT_CHROMA),
    dark: tint(colour, DARK_TINT_LIGHTNESS, TINT_CHROMA),
  }
}
