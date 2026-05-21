import { describe, it, expect } from 'vitest'
import { MoneyAmount, moneyAmount, zeroMoney } from '../MoneyAmount'

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
})
