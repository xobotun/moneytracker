import { describe, it, expect } from 'vitest'
import type { MoneyAmount } from '../MoneyAmount'
import { moneyAmount, moneyToNumber, sumMoney, zeroMoney } from '../MoneyAmount'

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

describe('sumMoney', () => {
  it('adds exactly at the largest scale', () => {
    expect(sumMoney([moneyAmount(15, 1, 'EUR'), moneyAmount(25, 2, 'EUR')], 'EUR')).toEqual(
      moneyAmount(175, 2, 'EUR'),
    )
  })

  it('is zero for no amounts', () => {
    expect(sumMoney([], 'EUR')).toEqual(moneyAmount(0, 2, 'EUR'))
  })

  it('refuses mixed currencies', () => {
    expect(() => sumMoney([moneyAmount(1, 2, 'EUR'), moneyAmount(1, 2, 'USD')], 'EUR')).toThrow()
  })
})

describe('moneyToNumber', () => {
  it('turns value and scale into a number', () => {
    expect(moneyToNumber(moneyAmount(-1234, 2, 'EUR'))).toBe(-12.34)
  })
})
