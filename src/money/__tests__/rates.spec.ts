import { describe, it, expect } from 'vitest'
import { asUuid } from '@/db/uuid'
import type { ExchangeRate } from '@/db/types'
import { RateTable } from '../rates'

function row(
  date: string,
  base_currency: string,
  rates: Record<string, number>,
  provider = 'ecb',
): ExchangeRate {
  return {
    id: asUuid(`${date}-${base_currency}-${provider}`),
    date,
    base_currency,
    rates,
    provider,
    created_at_utc: new Date(),
    updated_at_utc: new Date(),
    deleted_at_utc: null,
  }
}

describe('RateTable (placeholder rules)', () => {
  it('converts from and to the base, and across two listed currencies', () => {
    const t = RateTable.fromRows([row('2026-10-24', 'EUR', { USD: 1.1, RUB: 100 })])
    expect(t.convert(10, 'EUR', 'USD')).toBeCloseTo(11)
    expect(t.convert(11, 'USD', 'EUR')).toBeCloseTo(10)
    expect(t.convert(110, 'USD', 'RUB')).toBeCloseTo(10000)
  })

  it('needs no rate to keep a currency', () => {
    expect(RateTable.empty.convert(5, 'BTC', 'BTC')).toBe(5)
  })

  it('returns null when nothing can convert', () => {
    const t = RateTable.fromRows([row('2026-10-24', 'EUR', { USD: 1.1 })])
    expect(t.convert(1, 'EUR', 'GBP')).toBeNull()
    expect(RateTable.empty.convert(1, 'EUR', 'USD')).toBeNull()
  })

  it('uses only the newest date', () => {
    const t = RateTable.fromRows([
      row('2026-10-23', 'EUR', { USD: 1.0, GBP: 0.8 }),
      row('2026-10-24', 'EUR', { USD: 1.2 }),
    ])
    expect(t.date).toBe('2026-10-24')
    expect(t.convert(1, 'EUR', 'USD')).toBeCloseTo(1.2)
    expect(t.convert(1, 'EUR', 'GBP')).toBeNull() // not carried over from an older day
  })

  it('tries providers by name, the first that can convert winning', () => {
    const t = RateTable.fromRows([
      row('2026-10-24', 'EUR', { USD: 1.3 }, 'zeta'),
      row('2026-10-24', 'EUR', { USD: 1.1 }, 'alpha'),
      row('2026-10-24', 'EUR', { GBP: 0.85 }, 'zeta'),
    ])
    expect(t.convert(1, 'EUR', 'USD')).toBeCloseTo(1.1)
    expect(t.convert(1, 'EUR', 'GBP')).toBeCloseTo(0.85)
  })
})
