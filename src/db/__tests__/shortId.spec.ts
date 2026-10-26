import { describe, it, expect, vi, afterEach } from 'vitest'
import { newShortId, asShortId, SHORT_ID_LENGTH } from '../shortId'

describe('newShortId', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 12 base-62 characters', () => {
    expect(SHORT_ID_LENGTH).toBe(12)
    for (let i = 0; i < 100; i++) {
      expect(newShortId()).toMatch(/^[0-9A-Za-z]{12}$/)
    }
  })

  it('returns unique ids', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newShortId()))
    expect(ids.size).toBe(10_000)
  })

  it('draws from crypto.getRandomValues', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    newShortId()
    expect(spy).toHaveBeenCalled()
  })

  it('discards bytes of 248 and above, so every character is equally likely', () => {
    // 248 = 4 × 62: a byte below it maps onto the alphabet evenly. The first
    // draw is all rejects, so the id comes from the second one.
    let call = 0
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView>(array: T): T => {
        const bytes = array as unknown as Uint8Array
        bytes.fill(call === 0 ? 248 : 63) // 63 % 62 = 1 → '1'
        call++
        return array
      },
    )
    expect(newShortId()).toBe('111111111111')
  })
})

describe('asShortId', () => {
  it('adopts a string unchanged', () => {
    expect(asShortId('4kQ9xZr2BvLm')).toBe('4kQ9xZr2BvLm')
  })
})
