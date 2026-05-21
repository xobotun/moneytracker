import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../Database'
import { runMigrations } from '../migrations'
import { migration as settingsMigration } from '../migrations/001_settings'
import { migration as domainMigration } from '../migrations/002_domain_schema'

const EXPECTED_TABLES = [
  'accounts',
  'transactions',
  'exchange_rates',
  'tags',
  'locations',
  'account_groupings',
]

describe('domain schema migration', () => {
  let db: Database

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates all six domain tables', async () => {
    const rows = await db.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN " +
        `(${EXPECTED_TABLES.map(() => '?').join(',')}) ORDER BY name`,
      EXPECTED_TABLES
    )
    expect(rows.map((r) => r.name).sort()).toEqual([...EXPECTED_TABLES].sort())
  })

  it('rejects malformed JSON in tags column (json_valid CHECK)', async () => {
    await expect(
      db.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?)`,
        ['loc1', 'X', 'not json', '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
      )
    ).rejects.toThrow()
  })

  it('enforces FK from accounts.location_id to locations.id', async () => {
    await expect(
      db.run(
        `INSERT INTO accounts (id, name, currency, balance_value, balance_scale,
                               location_id, colour, icon, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['a1', 'Acc', 'USD', 0, 2, 'missing-loc', '#FFFFFF', 'cash',
         '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
      )
    ).rejects.toThrow()
  })

  it('enforces FK from transactions.account_id__from to accounts.id', async () => {
    await expect(
      db.run(
        `INSERT INTO transactions (id, account_id__from, account_id__to,
                                   amount_value__from, amount_scale__from, amount_currency__from,
                                   amount_value__to, amount_scale__to, amount_currency__to,
                                   transaction_at_local, transaction_at_zone,
                                   created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['t1', 'missing-acc', null, 100, 2, 'USD', 100, 2, 'USD',
         '2026-05-20T12:00:00.000+02:00', 'Europe/Berlin',
         '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
      )
    ).rejects.toThrow()
  })

  it('allows account_id__from / account_id__to to be NULL (Global Economy)', async () => {
    await db.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale,
                             colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['a1', 'Acc', 'USD', 0, 2, '#FFFFFF', 'cash',
       '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
    )
    await db.run(
      `INSERT INTO transactions (id, account_id__from, account_id__to,
                                 amount_value__from, amount_scale__from, amount_currency__from,
                                 amount_value__to, amount_scale__to, amount_currency__to,
                                 transaction_at_local, transaction_at_zone,
                                 created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['t1', null, 'a1', 100, 2, 'USD', 100, 2, 'USD',
       '2026-05-20T12:00:00.000+02:00', 'Europe/Berlin',
       '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
    )
    const rows = await db.exec('SELECT id FROM transactions')
    expect(rows).toHaveLength(1)
  })
})
