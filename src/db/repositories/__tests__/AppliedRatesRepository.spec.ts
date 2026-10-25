import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { AppliedRatesRepository, appliedRateId } from '../AppliedRatesRepository'

const D = '2026-10-20'
const DIRECT = { rate: 0.5, provider: 'fawazahmed0', via: null, referenceDate: D }

async function newDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

describe('AppliedRatesRepository', () => {
  let db: Database
  let repo: AppliedRatesRepository

  beforeEach(async () => {
    db = await newDb()
    repo = new AppliedRatesRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('stores a pair in alphabetical order, with the rate turned to match', async () => {
    expect(await repo.saveAuto({ date: D, x: 'USD', y: 'EUR', resolution: DIRECT })).toBe(true)
    const row = await repo.find(D, 'USD', 'EUR')
    expect(row).toMatchObject({
      id: appliedRateId(D, 'EUR', 'USD'),
      date: D,
      currency_a: 'EUR',
      currency_b: 'USD',
      rate: 2,
      provider: 'fawazahmed0',
      via: null,
      reference_date: D,
    })
    expect(await repo.find(D, 'EUR', 'USD')).toEqual(row)
  })

  it('gives the same id on two devices for one day and pair', async () => {
    const other = await newDb()
    try {
      await repo.saveAuto({ date: D, x: 'EUR', y: 'USD', resolution: DIRECT })
      await new AppliedRatesRepository(other).saveAuto({
        date: D,
        x: 'USD',
        y: 'EUR',
        resolution: DIRECT,
      })
      const mine = await repo.find(D, 'EUR', 'USD')
      const theirs = await new AppliedRatesRepository(other).find(D, 'EUR', 'USD')
      expect(theirs!.id).toBe(mine!.id)
    } finally {
      await other.close()
    }
  })

  it('stores an empty row when nothing was found', async () => {
    await repo.saveAuto({ date: D, x: 'MILES', y: 'EUR', resolution: null })
    expect(await repo.find(D, 'EUR', 'MILES')).toMatchObject({
      rate: null,
      provider: null,
      via: null,
      reference_date: null,
    })
  })

  it('does not write a row that would not change', async () => {
    await repo.saveAuto({ date: D, x: 'EUR', y: 'USD', resolution: DIRECT })
    const before = await repo.find(D, 'EUR', 'USD')
    await new Promise((r) => setTimeout(r, 5))
    expect(await repo.saveAuto({ date: D, x: 'EUR', y: 'USD', resolution: DIRECT })).toBe(false)
    expect((await repo.find(D, 'EUR', 'USD'))!.updated_at_utc).toEqual(before!.updated_at_utc)

    const cross = { ...DIRECT, via: 'GBP' }
    expect(await repo.saveAuto({ date: D, x: 'EUR', y: 'USD', resolution: cross })).toBe(true)
    expect((await repo.find(D, 'EUR', 'USD'))!.via).toBe('GBP')
  })

  it('saveAuto never touches a manual row', async () => {
    await repo.setManual(D, 'EUR', 'USD', 1.5)
    expect(await repo.saveAuto({ date: D, x: 'EUR', y: 'USD', resolution: DIRECT })).toBe(false)
    expect(await repo.find(D, 'EUR', 'USD')).toMatchObject({ rate: 1.5, provider: 'manual' })
  })

  it('sets an override over the app’s row, either way round', async () => {
    await repo.saveAuto({ date: D, x: 'EUR', y: 'USD', resolution: DIRECT })
    await repo.setManual(D, 'USD', 'EUR', 0.8)
    expect(await repo.find(D, 'EUR', 'USD')).toMatchObject({
      rate: 1.25,
      provider: 'manual',
      via: null,
      reference_date: D,
    })
  })

  it('removing an override leaves an empty auto row to resolve again', async () => {
    await repo.setManual(D, 'EUR', 'USD', 1.5)
    await repo.removeManual(D, 'USD', 'EUR')
    expect(await repo.find(D, 'EUR', 'USD')).toMatchObject({
      rate: null,
      provider: null,
      via: null,
      reference_date: null,
    })
    expect(await repo.saveAuto({ date: D, x: 'EUR', y: 'USD', resolution: DIRECT })).toBe(true)
  })

  it('lists a day’s rows, and the app’s own rows since a date', async () => {
    await repo.saveAuto({ date: D, x: 'EUR', y: 'USD', resolution: DIRECT })
    await repo.setManual(D, 'EUR', 'GBP', 0.9)
    await repo.saveAuto({ date: '2026-10-10', x: 'EUR', y: 'KZT', resolution: DIRECT })

    expect((await repo.listForDate(D)).map((r) => r.currency_b).sort()).toEqual(['GBP', 'USD'])
    expect((await repo.listAuto('2026-10-15')).map((r) => r.currency_b)).toEqual(['USD'])
    expect((await repo.listAuto('2026-10-01')).map((r) => r.currency_b).sort()).toEqual([
      'KZT',
      'USD',
    ])
  })

  it('refuses a pair that is not in alphabetical order', async () => {
    const now = new Date().toISOString()
    await expect(
      db.run(
        `INSERT INTO applied_rates (id, date, currency_a, currency_b, created_at_utc, updated_at_utc)
         VALUES ('x', ?, 'USD', 'EUR', ?, ?)`,
        [D, now, now],
      ),
    ).rejects.toThrow(/CHECK constraint failed/)
  })
})
