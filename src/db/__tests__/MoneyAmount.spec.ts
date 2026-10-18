import { describe, it, expect } from 'vitest'
import type { MoneyAmount } from '../MoneyAmount'
import { moneyAmount, zeroMoney } from '../MoneyAmount'

describe('MoneyAmount', () => {
  it('factory returns a frozen object with the three fields', () => {
    const m: MoneyAmount = moneyAmount(1234, 2, 'USD')
    expect(m).toEqual({ value: 1234, scale: 2, currency: 'USD' })
    expect(Object.isFrozen(m)).toBe(true)
  })

  it('zeroMoney returns a zero-value amount in the given currency', () => {
    expect(zeroMoney('EUR', 2)).toEqual({ value: 0, scale: 2, currency: 'EUR' })
  })

  it('rejects non-integer value', () => {
    expect(() => moneyAmount(1.5, 2, 'USD')).toThrow()
  })

  it('rejects negative scale', () => {
    expect(() => moneyAmount(100, -1, 'USD')).toThrow()
  })

  it('rejects empty currency code', () => {
    expect(() => moneyAmount(100, 2, '')).toThrow()
  })

  it('accepts crypto-scale amounts (BTC with scale=8)', () => {
    const m = moneyAmount(1, 8, 'BTC')
    expect(m.value).toBe(1)
    expect(m.scale).toBe(8)
  })

  it('accepts the largest exactly representable value', () => {
    expect(moneyAmount(Number.MAX_SAFE_INTEGER, 2, 'USD').value).toBe(Number.MAX_SAFE_INTEGER)
    expect(moneyAmount(-Number.MAX_SAFE_INTEGER, 2, 'USD').value).toBe(-Number.MAX_SAFE_INTEGER)
  })

  it('rejects values beyond 2^53 that a JS number cannot hold exactly', () => {
    // Number.isInteger(2 ** 60) is true, but the value has already lost precision.
    expect(() => moneyAmount(Number.MAX_SAFE_INTEGER + 1, 2, 'USD')).toThrow(/safe integer/)
    expect(() => moneyAmount(2 ** 60, 18, 'ETH')).toThrow(/safe integer/)
  })
})
