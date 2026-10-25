import { describe, it, expect } from 'vitest'
import { asUuid } from '@/db/uuid'
import type { AppliedRate, ExchangeRate } from '@/db/types'
import type { RateProvider } from '../providers'
import { isBetter, isFinal, resolveRate, type Resolution } from '../resolveRate'

function provider(id: string, priority: number): RateProvider {
  return { id, priority, fetchDay: async () => [] }
}

const PROVIDERS = [provider('bank', 10), provider('bank2', 10), provider('agg', 20)]

function row(
  date: string,
  base_currency: string,
  provider: string,
  rates: Record<string, number>,
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

function applied(fields: Partial<AppliedRate>): AppliedRate {
  return {
    id: asUuid('x'),
    date: '2026-10-20',
    currency_a: 'EUR',
    currency_b: 'USD',
    rate: 2,
    provider: 'bank',
    via: null,
    reference_date: '2026-10-20',
    created_at_utc: new Date(),
    updated_at_utc: new Date(),
    deleted_at_utc: null,
    ...fields,
  }
}

const D = '2026-10-20'

describe('resolveRate', () => {
  it('takes a direct rate from the base', () => {
    const rows = [row(D, 'EUR', 'bank', { USD: 2 })]
    expect(resolveRate(D, 'EUR', 'USD', rows, PROVIDERS)).toEqual({
      rate: 2,
      provider: 'bank',
      via: null,
      referenceDate: D,
    })
  })

  it('takes a direct rate the other way round', () => {
    const rows = [row(D, 'EUR', 'bank', { USD: 2 })]
    expect(resolveRate(D, 'USD', 'EUR', rows, PROVIDERS)).toMatchObject({ rate: 0.5, via: null })
  })

  it('crosses through the base of one row', () => {
    const rows = [row(D, 'EUR', 'bank', { USD: 2, PLN: 4 })]
    expect(resolveRate(D, 'PLN', 'USD', rows, PROVIDERS)).toEqual({
      rate: 0.5,
      provider: 'bank',
      via: 'EUR',
      referenceDate: D,
    })
  })

  it('crosses with legs from two providers of one level', () => {
    const rows = [row(D, 'EUR', 'bank', { CZK: 25 }), row(D, 'KZT', 'bank2', { EUR: 0.002 })]
    const r = resolveRate(D, 'CZK', 'KZT', rows, PROVIDERS)!
    expect(r.rate).toBeCloseTo(20) // 1 CZK = 1/25 EUR = 500/25 KZT
    expect(r).toMatchObject({ provider: 'bank+bank2', via: 'EUR' })
  })

  it('lets the first level that answers win, even with a cross', () => {
    const rows = [row(D, 'EUR', 'bank', { CZK: 25, PLN: 4 }), row(D, 'CZK', 'agg', { PLN: 0.17 })]
    expect(resolveRate(D, 'CZK', 'PLN', rows, PROVIDERS)).toMatchObject({
      provider: 'bank',
      via: 'EUR',
    })
  })

  it('falls through to the next level when a level has nothing', () => {
    const rows = [row(D, 'EUR', 'bank', { USD: 2 }), row(D, 'CZK', 'agg', { PLN: 0.17 })]
    expect(resolveRate(D, 'CZK', 'PLN', rows, PROVIDERS)).toMatchObject({
      rate: 0.17,
      provider: 'agg',
      via: null,
    })
  })

  it('prefers a direct rate to a cross within a level', () => {
    const rows = [
      row(D, 'EUR', 'bank', { KZT: 500, AMD: 400 }),
      row(D, 'KZT', 'bank2', { AMD: 0.8 }),
    ]
    expect(resolveRate(D, 'KZT', 'AMD', rows, PROVIDERS)).toMatchObject({
      rate: 0.8,
      provider: 'bank2',
      via: null,
    })
  })

  it('uses the newest rate on or before the date, up to 7 days back', () => {
    const rows = [
      row('2026-10-12', 'EUR', 'bank', { USD: 1 }),
      row('2026-10-16', 'EUR', 'bank', { USD: 2 }),
      row('2026-10-19', 'EUR', 'bank', { USD: 3 }),
    ]
    expect(resolveRate('2026-10-18', 'EUR', 'USD', rows, PROVIDERS)).toMatchObject({
      rate: 2,
      referenceDate: '2026-10-16',
    })
    expect(resolveRate('2026-10-23', 'EUR', 'USD', rows, PROVIDERS)).toMatchObject({
      referenceDate: '2026-10-19',
    })
    expect(resolveRate('2026-10-26', 'EUR', 'USD', rows, PROVIDERS)).toMatchObject({
      referenceDate: '2026-10-19',
    })
    expect(resolveRate('2026-10-27', 'EUR', 'USD', rows, PROVIDERS)).toBeNull()
    expect(resolveRate('2026-10-11', 'EUR', 'USD', rows, PROVIDERS)).toBeNull()
  })

  it('takes a cross as old as its older leg', () => {
    const rows = [
      row('2026-10-14', 'EUR', 'bank', { CZK: 25 }),
      row(D, 'KZT', 'bank2', { EUR: 0.002 }),
    ]
    expect(resolveRate(D, 'CZK', 'KZT', rows, PROVIDERS)).toMatchObject({
      referenceDate: '2026-10-14',
    })
  })

  it('returns null when nothing converts, and ignores unknown providers', () => {
    const rows = [row(D, 'EUR', 'bank', { USD: 2 }), row(D, 'EUR', 'nobody', { GBP: 0.9 })]
    expect(resolveRate(D, 'EUR', 'GBP', rows, PROVIDERS)).toBeNull()
  })

  it('skips rates that are not positive numbers', () => {
    const rows = [row(D, 'EUR', 'bank', { USD: 0, GBP: -1 })]
    expect(resolveRate(D, 'EUR', 'USD', rows, PROVIDERS)).toBeNull()
    expect(resolveRate(D, 'EUR', 'GBP', rows, PROVIDERS)).toBeNull()
  })
})

describe('isFinal', () => {
  const today = '2026-10-25'

  it('holds for a manual row', () => {
    expect(isFinal(applied({ provider: 'manual', date: today }), today, PROVIDERS)).toBe(true)
  })

  it('never holds for a cross or an empty row', () => {
    expect(isFinal(applied({ via: 'USD' }), today, PROVIDERS)).toBe(false)
    expect(
      isFinal(applied({ rate: null, provider: null, reference_date: null }), today, PROVIDERS),
    ).toBe(false)
  })

  it('needs the top level', () => {
    expect(isFinal(applied({ provider: 'agg' }), today, PROVIDERS)).toBe(false)
    expect(isFinal(applied({ provider: 'bank2' }), today, PROVIDERS)).toBe(true)
  })

  it('holds for a fallback date only once the day is settled', () => {
    const fallback = { reference_date: '2026-10-23' }
    expect(isFinal(applied({ ...fallback, date: '2026-10-25' }), today, PROVIDERS)).toBe(false)
    expect(isFinal(applied({ ...fallback, date: '2026-10-24' }), today, PROVIDERS)).toBe(false)
    expect(
      isFinal(
        applied({ ...fallback, date: '2026-10-23', reference_date: '2026-10-22' }),
        today,
        PROVIDERS,
      ),
    ).toBe(true)
    expect(isFinal(applied({ date: today, reference_date: today }), today, PROVIDERS)).toBe(true)
  })
})

describe('isBetter', () => {
  const direct: Resolution = { rate: 2, provider: 'bank', via: null, referenceDate: D }

  it('beats no row and an empty row', () => {
    expect(isBetter(direct, null, PROVIDERS)).toBe(true)
    expect(
      isBetter(direct, applied({ rate: null, provider: null, reference_date: null }), PROVIDERS),
    ).toBe(true)
  })

  it('ranks the level first, then direct over cross, then the newer date', () => {
    expect(isBetter(direct, applied({ provider: 'agg' }), PROVIDERS)).toBe(true)
    expect(
      isBetter(
        { ...direct, provider: 'agg' },
        applied({ provider: 'bank', via: 'USD' }),
        PROVIDERS,
      ),
    ).toBe(false)
    expect(isBetter(direct, applied({ via: 'USD' }), PROVIDERS)).toBe(true)
    expect(isBetter({ ...direct, via: 'USD' }, applied({}), PROVIDERS)).toBe(false)
    expect(isBetter(direct, applied({ reference_date: '2026-10-19' }), PROVIDERS)).toBe(true)
    expect(isBetter({ ...direct, referenceDate: '2026-10-19' }, applied({}), PROVIDERS)).toBe(false)
  })

  it('is false for an equal rank, and never beats a manual row', () => {
    expect(isBetter(direct, applied({}), PROVIDERS)).toBe(false)
    expect(
      isBetter(direct, applied({ provider: 'manual', reference_date: '2026-10-01' }), PROVIDERS),
    ).toBe(false)
  })
})
