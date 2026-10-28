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
  'location_details',
  'merchant_details',
  'journey_details',
  'account_groupings',
  'applied_rates',
  'images',
]

const AT = '2026-05-20T00:00:00.000Z'

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

  it('creates the domain tables and nothing else (no locations table)', async () => {
    const rows = await db.exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT IN ('settings', 'migrations')`,
    )
    expect(rows.map((r) => r.name).sort()).toEqual([...EXPECTED_TABLES].sort())
  })

  describe('tags', () => {
    const insertTag = (id: string, kind: string, parentId: string | null = null, synonyms = '[]') =>
      db.run(
        `INSERT INTO tags (id, kind, name, parent_id, moved_at_utc, synonyms,
                           created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, kind, `Tag ${id}`, parentId, AT, synonyms, AT, AT],
      )

    it('accepts the five kinds', async () => {
      for (const kind of ['category', 'merchant', 'location', 'journey', 'tag']) {
        await insertTag(`id-${kind}`, kind)
      }
      expect(await db.exec('SELECT id FROM tags')).toHaveLength(5)
    })

    it("rejects any other kind (kind = 'shop')", async () => {
      await expect(insertTag('t1', 'shop')).rejects.toThrow(/CHECK constraint failed/)
    })

    it('rejects a parent_id pointing nowhere', async () => {
      await expect(insertTag('t1', 'tag', 'missing')).rejects.toThrow(
        /FOREIGN KEY constraint failed/,
      )
    })

    it('rejects a tag that is its own parent', async () => {
      await expect(insertTag('t1', 'tag', 't1')).rejects.toThrow(/CHECK constraint failed/)
    })

    it('rejects malformed JSON in synonyms (json_valid CHECK)', async () => {
      await expect(insertTag('t1', 'tag', null, 'not json')).rejects.toThrow(
        /CHECK constraint failed/,
      )
    })

    it('rejects details of a tag that does not exist', async () => {
      await expect(
        db.run(
          `INSERT INTO location_details (tag_id, created_at_utc, updated_at_utc) VALUES (?, ?, ?)`,
          ['missing', AT, AT],
        ),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/)
    })
  })

  it('enforces FK from accounts.location_id to tags.id', async () => {
    await db.run(
      `INSERT INTO tags (id, kind, name, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES ('loc', 'location', 'Home', ?, ?, ?)`,
      [AT, AT, AT],
    )
    const insertAccount = (id: string, locationId: string) =>
      db.run(
        `INSERT INTO accounts (id, name, currency, balance_value, balance_scale,
                               location_id, colour, icon, created_at_utc, updated_at_utc)
         VALUES (?, 'Acc', 'USD', 0, 2, ?, '#FFFFFF', 'cash', ?, ?)`,
        [id, locationId, AT, AT],
      )
    await insertAccount('a0', 'loc')
    expect(await db.exec('SELECT id FROM accounts')).toHaveLength(1)
    await expect(insertAccount('a1', 'missing-loc')).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    )
  })

  it('enforces FK from transactions.location_id to tags.id', async () => {
    await expect(
      db.run(
        `INSERT INTO transactions (id,
                                   amount_value__from, amount_scale__from, amount_currency__from,
                                   amount_value__to, amount_scale__to, amount_currency__to,
                                   transaction_at_local, transaction_at_zone,
                                   location_id, created_at_utc, updated_at_utc)
         VALUES ('t1', 100, 2, 'USD', 100, 2, 'USD',
                 '2026-05-20T12:00:00.000+02:00', 'Europe/Berlin', 'missing-loc', ?, ?)`,
        [AT, AT],
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
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
        [
          't1',
          'missing-acc',
          null,
          100,
          2,
          'USD',
          100,
          2,
          'USD',
          '2026-05-20T12:00:00.000+02:00',
          'Europe/Berlin',
          '2026-05-20T00:00:00.000Z',
          '2026-05-20T00:00:00.000Z',
        ],
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it('allows account_id__from / account_id__to to be NULL (Global Economy)', async () => {
    await db.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale,
                             colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'a1',
        'Acc',
        'USD',
        0,
        2,
        '#FFFFFF',
        'cash',
        '2026-05-20T00:00:00.000Z',
        '2026-05-20T00:00:00.000Z',
      ],
    )
    await db.run(
      `INSERT INTO transactions (id, account_id__from, account_id__to,
                                 amount_value__from, amount_scale__from, amount_currency__from,
                                 amount_value__to, amount_scale__to, amount_currency__to,
                                 transaction_at_local, transaction_at_zone,
                                 created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        't1',
        null,
        'a1',
        100,
        2,
        'USD',
        100,
        2,
        'USD',
        '2026-05-20T12:00:00.000+02:00',
        'Europe/Berlin',
        '2026-05-20T00:00:00.000Z',
        '2026-05-20T00:00:00.000Z',
      ],
    )
    const rows = await db.exec('SELECT id FROM transactions')
    expect(rows).toHaveLength(1)
  })

  it.each([
    ['local without zone', '2026-05-21T09:00:00.000+02:00', null],
    ['zone without local', null, 'Europe/Berlin'],
  ])('rejects a half-set date_override (%s)', async (_label, overrideLocal, overrideZone) => {
    await expect(
      db.run(
        `INSERT INTO transactions (id, account_id__from, account_id__to,
                                   amount_value__from, amount_scale__from, amount_currency__from,
                                   amount_value__to, amount_scale__to, amount_currency__to,
                                   transaction_at_local, transaction_at_zone,
                                   date_override_local, date_override_zone,
                                   created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          't1',
          null,
          null,
          100,
          2,
          'USD',
          100,
          2,
          'USD',
          '2026-05-20T12:00:00.000+02:00',
          'Europe/Berlin',
          overrideLocal,
          overrideZone,
          '2026-05-20T00:00:00.000Z',
          '2026-05-20T00:00:00.000Z',
        ],
      ),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  describe('transactions.description__auto', () => {
    const insert = (descriptionAuto: string | null) =>
      db.run(
        `INSERT INTO transactions (id,
                                   amount_value__from, amount_scale__from, amount_currency__from,
                                   amount_value__to, amount_scale__to, amount_currency__to,
                                   transaction_at_local, transaction_at_zone,
                                   description__auto, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          't1',
          100,
          2,
          'USD',
          100,
          2,
          'USD',
          '2026-05-20T12:00:00.000+02:00',
          'Europe/Berlin',
          descriptionAuto,
          '2026-05-20T00:00:00.000Z',
          '2026-05-20T00:00:00.000Z',
        ],
      )

    it('rejects malformed JSON (json_valid CHECK)', async () => {
      await expect(insert('not json')).rejects.toThrow(/CHECK constraint failed/)
    })

    it('accepts NULL (entered by hand) and a JSON object', async () => {
      await insert(null)
      await db.run('DELETE FROM transactions')
      await insert('{"source":"ocr","raw":"KAFFEE 3,50"}')
      const rows = await db.exec<{ d: string }>('SELECT description__auto AS d FROM transactions')
      expect(rows).toEqual([{ d: '{"source":"ocr","raw":"KAFFEE 3,50"}' }])
    })
  })

  describe('accounts.is_cash', () => {
    const insert = (isCash?: number) =>
      db.run(
        `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, colour, icon,
                               ${isCash === undefined ? '' : 'is_cash,'} created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${isCash === undefined ? '' : '?,'} ?, ?)`,
        [
          'a1',
          'Acc',
          'USD',
          0,
          2,
          '#FFFFFF',
          'wallet',
          ...(isCash === undefined ? [] : [isCash]),
          '2026-05-20T00:00:00.000Z',
          '2026-05-20T00:00:00.000Z',
        ],
      )

    it('defaults to 0 (not cash)', async () => {
      await insert()
      const rows = await db.exec<{ is_cash: number }>('SELECT is_cash FROM accounts')
      expect(rows).toEqual([{ is_cash: 0 }])
    })

    it('rejects anything but 0 and 1', async () => {
      await expect(insert(2)).rejects.toThrow(/CHECK constraint failed/)
    })
  })
})
