import { describe, it, expect } from 'vitest'
import {
  currencyCodeError,
  currencyName,
  currencySuggestions,
  currencySymbol,
  normaliseCurrencyCode,
} from '../currency'

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

describe('currency codes', () => {
  it('normalises a typed code', () => {
    expect(normaliseCurrencyCode('  usdt ')).toBe('USDT')
  })

  it('explains what is wrong with a code', () => {
    expect(currencyCodeError('')).toBe('Enter a currency code, e.g. EUR or BTC.')
    expect(currencyCodeError('  ')).toBe('Enter a currency code, e.g. EUR or BTC.')
    expect(currencyCodeError('US D')).toBe('A currency code has no spaces.')
    expect(currencyCodeError(' btc ')).toBeNull()
  })
})

describe('currencySuggestions', () => {
  it('puts the preferred codes first', () => {
    expect(currencySuggestions('', ['RUB', 'BTC']).slice(0, 2)).toEqual(['RUB', 'BTC'])
  })

  it('matches codes by prefix, then names', () => {
    const result = currencySuggestions('ru')
    expect(result[0]!.startsWith('RU')).toBe(true)
    expect(currencySuggestions('ruble')).toEqual(expect.arrayContaining(['RUB', 'BYN']))
  })
})
