import { describe, it, expect } from 'vitest'
import { emojiIcon, sameIcon, setIcon } from '../types'

describe('sameIcon', () => {
  it('compares icons by value, as stored', () => {
    expect(sameIcon(setIcon('pi', 'shop'), setIcon('pi', 'shop'))).toBe(true)
    expect(sameIcon(setIcon('pi', 'shop'), setIcon('pi', 'gift'))).toBe(false)
    expect(sameIcon(setIcon('pi', 'shop'), emojiIcon('shop'))).toBe(false)
    expect(
      sameIcon({ kind: 'unknown', json: '{"a":1}' }, { kind: 'unknown', json: '{"a":1}' }),
    ).toBe(true)
    expect(
      sameIcon({ kind: 'unknown', json: '{"a":1}' }, { kind: 'unknown', json: '{"a":2}' }),
    ).toBe(false)
  })

  it('tells "inherited" (null) from any icon', () => {
    expect(sameIcon(null, null)).toBe(true)
    expect(sameIcon(null, emojiIcon('🛒'))).toBe(false)
    expect(sameIcon(emojiIcon('🛒'), null)).toBe(false)
  })
})
