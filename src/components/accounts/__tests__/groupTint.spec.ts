import { describe, it, expect } from 'vitest'
import { DARK_TINT_LIGHTNESS, LIGHT_TINT_LIGHTNESS, groupTints, hexToOklch } from '../groupTint'

const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

describe('hexToOklch', () => {
  it('converts known colours', () => {
    expect(hexToOklch('#ffffff')).toMatchObject({
      l: expect.closeTo(1, 3),
      c: expect.closeTo(0, 3),
    })
    expect(hexToOklch('#000000')).toMatchObject({ l: expect.closeTo(0, 3) })
    // #3b82f6 (Tailwind v3 blue-500) is oklch(0.623 0.188 259.8).
    const blue = hexToOklch('#3b82f6')!
    expect(blue.l).toBeCloseTo(0.623, 2)
    expect(blue.c).toBeCloseTo(0.188, 2)
    expect(blue.h).toBeCloseTo(259.8, 0)
  })

  it('accepts #rgb and rejects anything else', () => {
    expect(hexToOklch('#fff')!.l).toBeCloseTo(1, 3)
    expect(hexToOklch('blue')).toBeNull()
  })
})

describe('groupTints', () => {
  it.each(['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7'])(
    'keeps the current block lightness and takes the hue of %s',
    (colour) => {
      const { light, dark } = groupTints(colour)
      const source = hexToOklch(colour)!
      const l = hexToOklch(light)!
      const d = hexToOklch(dark)!
      // Rounding to 8-bit hex costs a little precision.
      expect(l.l).toBeCloseTo(LIGHT_TINT_LIGHTNESS, 2)
      expect(d.l).toBeCloseTo(DARK_TINT_LIGHTNESS, 2)
      expect(hueDistance(l.h, source.h)).toBeLessThan(8)
      expect(hueDistance(d.h, source.h)).toBeLessThan(8)
      expect(l.c).toBeGreaterThan(0.015)
      expect(d.c).toBeGreaterThan(0.015)
    },
  )

  it('stays neutral for a grey colour', () => {
    const { light, dark } = groupTints('#808080')
    expect(hexToOklch(light)!.c).toBeLessThan(0.005)
    expect(hexToOklch(dark)!.c).toBeLessThan(0.005)
  })

  it('falls back to the neutral block colours for an unreadable colour', () => {
    expect(groupTints('nonsense')).toEqual(groupTints('#808080'))
  })
})
