import { describe, it, expect } from 'vitest'
import { initialView, roundCoordinate } from '../mapView'

describe('initialView', () => {
  it('centres on the position, closer for a small place', () => {
    expect(initialView({ latitude: 52.52, longitude: 13.405 }, 10, null)).toEqual({
      center: [52.52, 13.405],
      zoom: 18,
    })
    expect(initialView({ latitude: 52.52, longitude: 13.405 }, 400, null).zoom).toBe(15)
    expect(initialView({ latitude: 52.52, longitude: 13.405 }, 5000, null).zoom).toBe(11)
  })

  it("falls back to an ancestor's position, then to the whole world", () => {
    expect(initialView(null, 10, { latitude: 52.5, longitude: 13.4 })).toEqual({
      center: [52.5, 13.4],
      zoom: 13,
    })
    expect(initialView(null, 10, null)).toEqual({ center: [20, 0], zoom: 2 })
  })
})

describe('roundCoordinate', () => {
  it('keeps six decimals, about 10 cm', () => {
    expect(roundCoordinate(52.520008123)).toBe(52.520008)
    expect(roundCoordinate(-0.1234567)).toBe(-0.123457)
  })
})
