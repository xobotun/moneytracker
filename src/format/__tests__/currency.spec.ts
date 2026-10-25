import { describe, it, expect } from 'vitest'
import {
  currencyCodeError,
  currencyName,
  currencySuggestions,
  currencySymbol,
  formatApprox,
  formatMoney,
  normaliseCurrencyCode,
} from '../currency'
import { moneyAmount } from '@/db/MoneyAmount'

// Intl separates a code from the number with a no-break space; compare plainly.
const plain = (s: string) => s.replace(/\u00a0/g, ' ')

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

describe('formatMoney', () => {
  it('uses the symbol and the currency’s usual decimals', () => {
    expect(plain(formatMoney(moneyAmount(123456, 2, 'EUR'), 'en-US'))).toBe('€1,234.56')
    expect(plain(formatMoney(moneyAmount(-2550, 2, 'USD'), 'en-US'))).toBe('-$25.50')
    expect(plain(formatMoney(moneyAmount(500, 0, 'RUB'), 'en-US'))).toBe('₽500.00')
  })

  it('keeps every stored decimal, but drops none the currency has none of', () => {
    expect(plain(formatMoney(moneyAmount(1000, 2, 'JPY'), 'en-US'))).toBe('¥10')
    expect(plain(formatMoney(moneyAmount(1050, 2, 'JPY'), 'en-US'))).toBe('¥10.5')
    expect(plain(formatMoney(moneyAmount(150000001, 8, 'BTC'), 'en-US'))).toBe('BTC 1.50000001')
  })

  it('shows the code for a currency without a symbol, after the number for a custom one', () => {
    expect(plain(formatMoney(moneyAmount(1000, 2, 'CHF'), 'en-US'))).toBe('CHF 10.00')
    expect(plain(formatMoney(moneyAmount(5, 1, 'USDT'), 'en-US'))).toBe('0.50 USDT')
  })
})

describe('formatApprox', () => {
  it('rounds to the currency’s usual decimals', () => {
    expect(plain(formatApprox({ value: 1234.5678, currency: 'EUR' }, 'en-US'))).toBe('€1,234.57')
    expect(plain(formatApprox({ value: 1234.5678, currency: 'JPY' }, 'en-US'))).toBe('¥1,235')
    expect(plain(formatApprox({ value: 0.123, currency: 'USDT' }, 'en-US'))).toBe('0.12 USDT')
  })
})
