import { describe, it, expect } from 'vitest'
import { asUuid } from '@/db/uuid'
import type { AppliedRate } from '@/db/types'
import { RateTable } from '../rates'

function applied(currency_a: string, currency_b: string, rate: number | null): AppliedRate {
  return {
    id: asUuid(`${currency_a}-${currency_b}`),
    date: '2026-10-24',
    currency_a,
    currency_b,
    rate,
    provider: rate === null ? null : 'fawazahmed0',
    via: null,
    reference_date: rate === null ? null : '2026-10-24',
    created_at_utc: new Date(),
    updated_at_utc: new Date(),
    deleted_at_utc: null,
  }
}

describe('RateTable over applied rates', () => {
  const table = RateTable.fromApplied([applied('EUR', 'USD', 2), applied('EUR', 'MILES', null)])

  it('converts along the stored direction and back', () => {
    expect(table.convert(10, 'EUR', 'USD')).toBe(20)
    expect(table.convert(20, 'USD', 'EUR')).toBe(10)
  })

  it('keeps a currency without any row', () => {
    expect(table.convert(5, 'BTC', 'BTC')).toBe(5)
  })

  it('has nothing for an empty row or a pair it lacks', () => {
    expect(table.convert(1, 'MILES', 'EUR')).toBeNull()
    expect(table.convert(1, 'EUR', 'GBP')).toBeNull()
    expect(table.convert(1, 'USD', 'GBP')).toBeNull()
  })
})
