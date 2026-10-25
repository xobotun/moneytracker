import { describe, it, expect } from 'vitest'
import { currencyName, currencySymbol } from '../currency'

describe('currencySymbol', () => {
  it('returns the narrow symbol of an ISO currency', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('RUB')).toBe('₽')
    expect(currencySymbol('KZT')).toBe('₸')
  })

  it('returns null when the currency has no symbol of its own', () => {
    expect(currencySymbol('CHF')).toBeNull()
  })

  it('returns null for custom codes, well-formed or not', () => {
    expect(currencySymbol('BTC')).toBeNull()
    expect(currencySymbol('USDT')).toBeNull()
    expect(currencySymbol('')).toBeNull()
  })
})

describe('currencyName', () => {
  it('returns the English name of an ISO currency', () => {
    expect(currencyName('EUR')).toBe('Euro')
    expect(currencyName('RUB')).toBe('Russian Ruble')
  })

  it('returns null for custom codes', () => {
    expect(currencyName('BTC')).toBeNull()
    expect(currencyName('USDT')).toBeNull()
  })
})
