import { tint } from '@/components/accounts/groupTint'

function relativeLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const digits = m[1]!.length === 3 ? [...m[1]!].map((d) => d + d).join('') : m[1]!
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/**
 * Colour of a pack icon on a badge of `background`: white while it keeps the
 * 3:1 contrast WCAG asks of graphics, dark ink on light colours (yellow,
 * teal, …) otherwise.
 */
export function iconColourOn(background: string): string {
  const l = relativeLuminance(background)
  if (l === null) return '#ffffff'
  return 1.05 / (l + 0.05) >= 3 ? '#ffffff' : '#111827'
}

/**
 * The background of an emoji badge: a tint of the colour, light in the light
 * theme and dark in the dark one, so the emoji's own colours read on it.
 * OKLCH lightness, like the group blocks (groupTint.ts), a little stronger.
 */
export function emojiTints(colour: string): { light: string; dark: string } {
  return { light: tint(colour, 0.92, 0.06), dark: tint(colour, 0.36, 0.06) }
}
