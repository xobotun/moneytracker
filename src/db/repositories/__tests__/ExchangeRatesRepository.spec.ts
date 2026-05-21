import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { ExchangeRatesRepository } from '../ExchangeRatesRepository'

describe('ExchangeRatesRepository', () => {
  let db: Database
  let repo: ExchangeRatesRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    repo = new ExchangeRatesRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates and finds an exchange rate by id', async () => {
    const created = await repo.create({
      date: '2026-05-20',
      base_currency: 'USD',
      rates: { EUR: 0.92, GBP: 0.79 },
      provider: 'openexchangerates',
    })
    const found = await repo.findById(created.id)
    expect(found).not.toBeNull()
    expect(found?.date).toBe('2026-05-20')
    expect(found?.base_currency).toBe('USD')
    expect(found?.provider).toBe('openexchangerates')
  })

  it('round-trips rates JSON object', async () => {
    const rates = { AED: 3.67, EUR: 0.92, GBP: 0.79, JPY: 150.5 }
    const created = await repo.create({
      date: '2026-05-20',
      base_currency: 'USD',
      rates,
      provider: 'openexchangerates',
    })
    const found = await repo.findById(created.id)
    expect(found?.rates).toEqual(rates)
  })

  it('findRates returns multiple rows for same (date, base_currency) with different providers', async () => {
    await repo.create({
      date: '2026-05-20',
      base_currency: 'USD',
      rates: { EUR: 0.92 },
      provider: 'openexchangerates',
    })
    await repo.create({
      date: '2026-05-20',
      base_currency: 'USD',
      rates: { EUR: 0.91 },
      provider: 'fawazahmed0',
    })
    const found = await repo.findRates('2026-05-20', 'USD')
    expect(found).toHaveLength(2)
    expect(found.map((r) => r.provider).sort()).toEqual(['fawazahmed0', 'openexchangerates'])
  })

  it('findRates returns empty array when nothing matches', async () => {
    const found = await repo.findRates('2026-05-20', 'USD')
    expect(found).toEqual([])
  })

  it('findRates filters by date and base_currency', async () => {
    await repo.create({
      date: '2026-05-20',
      base_currency: 'USD',
      rates: { EUR: 0.92 },
      provider: 'openexchangerates',
    })
    await repo.create({
      date: '2026-05-21',
      base_currency: 'USD',
      rates: { EUR: 0.93 },
      provider: 'openexchangerates',
    })
    await repo.create({
      date: '2026-05-20',
      base_currency: 'EUR',
      rates: { USD: 1.09 },
      provider: 'openexchangerates',
    })
    const found = await repo.findRates('2026-05-20', 'USD')
    expect(found).toHaveLength(1)
    expect(found[0]!.date).toBe('2026-05-20')
    expect(found[0]!.base_currency).toBe('USD')
  })

  it('list() returns all non-deleted rates', async () => {
    await repo.create({
      date: '2026-05-20',
      base_currency: 'USD',
      rates: { EUR: 0.92 },
      provider: 'openexchangerates',
    })
    await repo.create({
      date: '2026-05-21',
      base_currency: 'EUR',
      rates: { USD: 1.09 },
      provider: 'fawazahmed0',
    })
    const list = await repo.list()
    expect(list).toHaveLength(2)
  })

  it('updates an exchange rate', async () => {
    const created = await repo.create({
      date: '2026-05-20',
      base_currency: 'USD',
      rates: { EUR: 0.92 },
      provider: 'openexchangerates',
    })
    await repo.update(created.id, { rates: { EUR: 0.95 } })
    const found = await repo.findById(created.id)
    expect(found?.rates).toEqual({ EUR: 0.95 })
  })

  it('soft-deletes an exchange rate', async () => {
    const created = await repo.create({
      date: '2026-05-20',
      base_currency: 'USD',
      rates: { EUR: 0.92 },
      provider: 'openexchangerates',
    })
    await repo.softDelete(created.id)
    expect(await repo.findById(created.id)).toBeNull()
    const list = await repo.list()
    expect(list).toHaveLength(0)
  })

  it('soft delete excludes from findRates', async () => {
    const created = await repo.create({
      date: '2026-05-20',
      base_currency: 'USD',
      rates: { EUR: 0.92 },
      provider: 'openexchangerates',
    })
    await repo.softDelete(created.id)
    const found = await repo.findRates('2026-05-20', 'USD')
    expect(found).toHaveLength(0)
  })
})
