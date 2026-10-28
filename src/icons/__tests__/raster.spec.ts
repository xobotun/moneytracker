import { describe, it, expect } from 'vitest'
import { base64, encodedMediaType, rasterLayout } from '../raster'

describe('rasterLayout', () => {
  it('fits a wide picture within 256 × 256, centred on a square', () => {
    expect(rasterLayout(1024, 512)).toEqual({ side: 256, x: 0, y: 64, width: 256, height: 128 })
  })

  it('fits a tall picture the same way', () => {
    expect(rasterLayout(300, 1200)).toEqual({ side: 256, x: 96, y: 0, width: 64, height: 256 })
  })

  it('keeps a square picture square', () => {
    expect(rasterLayout(4000, 4000)).toEqual({ side: 256, x: 0, y: 0, width: 256, height: 256 })
  })

  it('never enlarges a small picture', () => {
    expect(rasterLayout(32, 16)).toEqual({ side: 32, x: 0, y: 8, width: 32, height: 16 })
  })

  it('keeps at least a pixel of a very thin picture', () => {
    expect(rasterLayout(10000, 3)).toMatchObject({ width: 256, height: 1, side: 256 })
  })

  it('refuses a picture without pixels', () => {
    expect(() => rasterLayout(0, 10)).toThrow(RangeError)
  })
})

describe('encodedMediaType', () => {
  it('takes WebP, or PNG where the browser cannot write WebP (Safari)', () => {
    expect(encodedMediaType('image/webp')).toBe('image/webp')
    expect(encodedMediaType('image/png')).toBe('image/png')
    expect(encodedMediaType('image/jpeg')).toBeNull()
    expect(encodedMediaType('')).toBeNull()
  })
})

describe('base64', () => {
  it('encodes bytes, also more than one chunk of them', () => {
    expect(base64(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('iVBORw==')
    const big = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(Buffer.from(base64(big), 'base64').equals(Buffer.from(big))).toBe(true)
  })
})
