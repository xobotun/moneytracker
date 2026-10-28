import { describe, it, expect } from 'vitest'
import { emojiTints, iconColourOn } from '../colours'
import { hexToOklch } from '@/components/accounts/groupTint'

describe('iconColourOn', () => {
  it('picks dark ink on light backgrounds and white on dark ones', () => {
    expect(iconColourOn('#fde047')).toBe('#111827')
    expect(iconColourOn('#1e3a8a')).toBe('#ffffff')
    expect(iconColourOn('not a colour')).toBe('#ffffff')
  })
})

describe('emojiTints', () => {
  it('is the colour’s hue, light for the light theme and dark for the dark one', () => {
    const { light, dark } = emojiTints('#ef4444')
    const red = hexToOklch('#ef4444')!
    for (const [tint, lightness] of [
      [light, 0.92],
      [dark, 0.36],
    ] as const) {
      const t = hexToOklch(tint)!
      expect(t.l).toBeCloseTo(lightness, 2)
      expect(Math.abs(t.h - red.h)).toBeLessThan(3)
      expect(t.c).toBeGreaterThan(0.03)
    }
  })

  it('keeps a grey grey, and greys what is no colour', () => {
    expect(hexToOklch(emojiTints('#808080').light)!.c).toBeLessThan(0.001)
    expect(hexToOklch(emojiTints('currentColor').dark)!.c).toBeLessThan(0.001)
  })
})
