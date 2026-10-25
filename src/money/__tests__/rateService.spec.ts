import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { ExchangeRatesRepository } from '@/db/repositories/ExchangeRatesRepository'
import { AppliedRatesRepository } from '@/db/repositories/AppliedRatesRepository'
import type { ExchangeRateInput, RateProvider } from '../providers'
import { RateService } from '../rateService'

const TODAY = '2026-10-25'

interface FakeProvider extends RateProvider {
  calls: string[]
  /** What it publishes, by requested date; a function may throw. */
  answers: Record<string, ExchangeRateInput[]> | ((date: string) => ExchangeRateInput[])
}

function fake(id: string, priority: number): FakeProvider {
  const p: FakeProvider = {
    id,
    priority,
    calls: [],
    answers: {},
    async fetchDay(date) {
      p.calls.push(date)
      return typeof p.answers === 'function' ? p.answers(date) : (p.answers[date] ?? [])
    },
  }
  return p
}

const eur = (provider: string, date: string, rates: Record<string, number>): ExchangeRateInput => ({
  date,
  base_currency: 'EUR',
  provider,
  rates,
})

describe('RateService', () => {
  let db: Database
  let applied: AppliedRatesRepository
  let library: ExchangeRatesRepository
  let bank: FakeProvider
  let agg: FakeProvider
  let service: RateService

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    applied = new AppliedRatesRepository(db)
    library = new ExchangeRatesRepository(db)
    bank = fake('bank', 10)
    agg = fake('agg', 20)
    service = new RateService({
      exchangeRates: library,
      appliedRates: applied,
      providers: [bank, agg],
      today: () => TODAY,
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await db.close()
  })

  it('fetches, stores the reference rows, and applies the rate', async () => {
    agg.answers = { '2026-10-20': [eur('agg', '2026-10-20', { USD: 2 })] }
    expect(await service.ensure('2026-10-20', [['USD', 'EUR']])).toBe(1)
    expect(await applied.find('2026-10-20', 'EUR', 'USD')).toMatchObject({
      rate: 2,
      provider: 'agg',
      via: null,
      reference_date: '2026-10-20',
    })
    expect(await library.findRates('2026-10-20', 'EUR')).toHaveLength(1)
  })

  it('asks the higher level first and stops at the first that answers', async () => {
    bank.answers = { '2026-10-20': [eur('bank', '2026-10-20', { USD: 2.1 })] }
    agg.answers = { '2026-10-20': [eur('agg', '2026-10-20', { USD: 2 })] }
    await service.ensure('2026-10-20', [['EUR', 'USD']])
    expect((await applied.find('2026-10-20', 'EUR', 'USD'))!.provider).toBe('bank')
    expect(agg.calls).toEqual([])
  })

  it('fetches a provider day once per session, even for concurrent callers', async () => {
    agg.answers = { '2026-10-20': [eur('agg', '2026-10-20', { USD: 2, GBP: 0.9 })] }
    await Promise.all([
      service.ensure('2026-10-20', [['EUR', 'USD']]),
      service.ensure('2026-10-20', [
        ['EUR', 'GBP'],
        ['EUR', 'USD'],
      ]),
    ])
    expect(agg.calls).toEqual(['2026-10-20'])
    expect(bank.calls).toEqual(['2026-10-20'])
    await service.ensure('2026-10-20', [['EUR', 'CHF']])
    expect(agg.calls).toEqual(['2026-10-20'])
  })

  it('writes a NULL row when nothing resolves, and does not fetch again', async () => {
    expect(await service.ensure('2026-10-20', [['MILES', 'EUR']])).toBe(1)
    expect(await applied.find('2026-10-20', 'EUR', 'MILES')).toMatchObject({ rate: null })
    expect(await service.ensure('2026-10-20', [['MILES', 'EUR']])).toBe(0)
    expect(agg.calls).toHaveLength(1)
  })

  it('ensure survives a provider that throws', async () => {
    bank.answers = () => {
      throw new TypeError('Failed to fetch')
    }
    agg.answers = { '2026-10-20': [eur('agg', '2026-10-20', { USD: 2 })] }
    await expect(service.ensure('2026-10-20', [['EUR', 'USD']])).resolves.toBe(1)
    expect((await applied.find('2026-10-20', 'EUR', 'USD'))!.provider).toBe('agg')
  })

  it('ensure keeps a manual row', async () => {
    await applied.setManual('2026-10-20', 'EUR', 'USD', 1.5)
    agg.answers = { '2026-10-20': [eur('agg', '2026-10-20', { USD: 2 })] }
    expect(await service.ensure('2026-10-20', [['EUR', 'USD']])).toBe(0)
    expect((await applied.find('2026-10-20', 'EUR', 'USD'))!.rate).toBe(1.5)
    expect(agg.calls).toEqual([])
  })

  it('keeps a found rate when a later attempt finds nothing', async () => {
    agg.answers = { [TODAY]: [eur('agg', TODAY, { USD: 2 })] }
    await service.ensure(TODAY, [['EUR', 'USD']])
    await library.save({ ...eur('agg', TODAY, {}) })
    agg.answers = {}
    await service.refresh().catch(() => {})
    expect((await applied.find(TODAY, 'EUR', 'USD'))!.rate).toBe(2)
  })

  it('refresh replaces a lower level’s rate once a better level has one', async () => {
    agg.answers = { [TODAY]: [eur('agg', TODAY, { USD: 2 })] }
    await service.ensure(TODAY, [['EUR', 'USD']])
    expect((await applied.find(TODAY, 'EUR', 'USD'))!.provider).toBe('agg')

    bank.answers = { [TODAY]: [eur('bank', TODAY, { USD: 2.1 })] }
    expect(await service.refresh()).toEqual({ newest: TODAY })
    expect(await applied.find(TODAY, 'EUR', 'USD')).toMatchObject({ rate: 2.1, provider: 'bank' })
  })

  it('refresh rejects when no provider answers', async () => {
    const down = () => {
      throw new TypeError('Failed to fetch')
    }
    bank.answers = down
    agg.answers = down
    await expect(service.refresh()).rejects.toThrow()
  })

  it('is stale without rates newer than yesterday', async () => {
    expect(await service.isStale()).toBe(true)
    await library.save(eur('agg', '2026-10-23', { USD: 2 }))
    expect(await service.isStale()).toBe(true)
    await library.save(eur('agg', '2026-10-24', { USD: 2 }))
    expect(await service.isStale()).toBe(false)
  })
})
