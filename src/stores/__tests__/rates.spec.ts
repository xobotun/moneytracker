import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { AppliedRatesRepository } from '@/db/repositories/AppliedRatesRepository'
import { ExchangeRatesRepository } from '@/db/repositories/ExchangeRatesRepository'
import { todayLocal } from '@/money/dates'
import type { ExchangeRateInput, RateProvider } from '@/money/providers'
import { RateService } from '@/money/rateService'
import { useRatesStore } from '../rates'

// Real repositories and service over an in-memory database; only the rate
// source is fake.
let applied: AppliedRatesRepository
let service: RateService
vi.mock('@/db/init', () => ({
  getAppliedRatesRepository: () => applied,
  getRateService: () => service,
}))

describe('rates store', () => {
  let db: Database
  let answers: ExchangeRateInput[]
  let library: ExchangeRatesRepository
  const today = todayLocal()

  beforeEach(async () => {
    setActivePinia(createPinia())
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    applied = new AppliedRatesRepository(db)
    library = new ExchangeRatesRepository(db)
    answers = []
    const source: RateProvider = { id: 'src', priority: 20, fetchDay: async () => answers }
    service = new RateService({
      exchangeRates: library,
      appliedRates: applied,
      providers: [source],
      today: () => today,
    })
  })

  afterEach(async () => {
    await db.close()
  })

  it("loads today's applied rates into the table", async () => {
    await applied.setManual(today, 'EUR', 'USD', 2)
    const store = useRatesStore()
    await store.load()
    expect(store.table.convert(10, 'EUR', 'USD')).toBe(20)
  })

  it('resolves the pairs it is asked for, then shows them', async () => {
    answers = [{ date: today, base_currency: 'EUR', provider: 'src', rates: { USD: 2 } }]
    const store = useRatesStore()
    await store.ensure([['USD', 'EUR']])
    expect(store.table.convert(10, 'USD', 'EUR')).toBe(5)
  })

  it('refreshes and reports the newest date', async () => {
    answers = [{ date: today, base_currency: 'EUR', provider: 'src', rates: { USD: 2 } }]
    expect(await useRatesStore().refresh()).toBe(today)
  })

  it('refreshes at startup only when the rates are stale', async () => {
    const store = useRatesStore()
    const refresh = vi.spyOn(service, 'refresh')
    await store.refreshIfStale()
    expect(refresh).toHaveBeenCalledTimes(1)

    await library.save({ date: today, base_currency: 'EUR', provider: 'src', rates: { USD: 2 } })
    await store.refreshIfStale()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
