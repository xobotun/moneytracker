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

  describe('save, listBetween, newestDate', () => {
    const input = {
      date: '2026-10-20',
      base_currency: 'EUR',
      rates: { USD: 1.1 },
      provider: 'fawazahmed0',
    }

    it('inserts, then updates the rates, then reports an unchanged save', async () => {
      expect(await repo.save(input)).toBe(true)
      expect(await repo.save({ ...input, rates: { USD: 1.2, GBP: 0.9 } })).toBe(true)
      expect(await repo.save({ ...input, rates: { USD: 1.2, GBP: 0.9 } })).toBe(false)
      const rows = await repo.findRates('2026-10-20', 'EUR')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.rates).toEqual({ USD: 1.2, GBP: 0.9 })
    })

    it('lists the rows between two dates, both included', async () => {
      for (const date of ['2026-10-12', '2026-10-13', '2026-10-20', '2026-10-21']) {
        await repo.save({ ...input, date })
      }
      const rows = await repo.listBetween('2026-10-13', '2026-10-20')
      expect(rows.map((r) => r.date).sort()).toEqual(['2026-10-13', '2026-10-20'])
    })

    it('knows the newest date it holds', async () => {
      expect(await repo.newestDate()).toBeNull()
      await repo.save({ ...input, date: '2026-10-12' })
      await repo.save({ ...input, date: '2026-10-21', provider: 'other' })
      expect(await repo.newestDate()).toBe('2026-10-21')
    })
  })

  describe('deterministic id from (date, base_currency, provider)', () => {
    const input = {
      date: '2026-05-20',
      base_currency: 'USD',
      rates: { EUR: 0.92 },
      provider: 'openexchangerates',
    }

    it('gives the same id for the same key on every database', async () => {
      const otherDb = new Database()
      await otherDb.init()
      try {
        await runMigrations(otherDb, [settingsMigration, domainMigration])
        const a = await repo.create(input)
        const b = await new ExchangeRatesRepository(otherDb).create({
          ...input,
          rates: { EUR: 0.93 },
        })
        expect(b.id).toBe(a.id)
      } finally {
        await otherDb.close()
      }
    })

    it('gives different ids when any key part differs', async () => {
      const a = await repo.create(input)
      const b = await repo.create({ ...input, provider: 'fawazahmed0' })
      const c = await repo.create({ ...input, base_currency: 'EUR' })
      const d = await repo.create({ ...input, date: '2026-05-21' })
      expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4)
    })

    it('rejects a second rate for the same (date, base_currency, provider)', async () => {
      await repo.create(input)
      await expect(repo.create({ ...input, rates: { EUR: 0.99 } })).rejects.toThrow(
        /constraint failed/i,
      )
    })
  })
})
