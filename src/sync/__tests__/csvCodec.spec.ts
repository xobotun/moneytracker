import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import {
  exportTableToCsvFiles,
  importCsvIntoTable,
  exportAllTables,
  importAllTables,
} from '../csvCodec'
import { SYNC_TABLES } from '../syncTables'
import { rowsEqual } from '../rows'
import { newId } from '../../db/uuid'
import { seedTag, seedTags } from './helpers'
import Papa from 'papaparse'
import { hashDatabase } from '../hashDatabase'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

const CUTOFF = '2026-05-01T00:00:00.000Z'

describe('csvCodec', () => {
  let dbs: Database[] = []

  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
  })

  describe('exportTableToCsvFiles', () => {
    it('emits a header row followed by sorted-by-PK rows', async () => {
      const db = await migratedDb()
      dbs.push(db)
      const id1 = '0193ffffffffffffffffffffffffff01'
      const id2 = '0194000000000000000000000000a002'
      await db.run(
        `INSERT INTO tags (id, kind, name, synonyms, created_at_utc, updated_at_utc)
         VALUES (?, 'location', 'Two', '[]', ?, ?)`,
        [id2, CUTOFF, CUTOFF],
      )
      await db.run(
        `INSERT INTO tags (id, kind, name, synonyms, created_at_utc, updated_at_utc)
         VALUES (?, 'location', 'One', '[]', ?, ?)`,
        [id1, CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(db, { name: 'tags', pk: 'id' }))[0]!
      const lines = csv.split('\n').filter((l) => l.length > 0)
      expect(lines[0]).toMatch(/^id,kind,name,/)
      expect(lines[1]!).toContain(id1)
      expect(lines[2]!).toContain(id2)
    })

    it('quotes commas, double quotes, and embedded newlines per RFC 4180', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await db.run(
        `INSERT INTO tags (id, kind, name, synonyms, created_at_utc, updated_at_utc)
         VALUES (?, 'location', ?, '[]', ?, ?)`,
        [newId(), 'Smith, "Jr."\nNYC', CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(db, { name: 'tags', pk: 'id' }))[0]!
      // The Name cell should be quoted; the embedded double quote should
      // be doubled; the embedded newline should sit inside the quoted cell.
      expect(csv).toMatch(/"Smith, ""Jr\.""\nNYC"/)
    })

    it('emits NULL as an empty cell', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await db.run(
        `INSERT INTO tags (id, kind, name, description, created_at_utc, updated_at_utc)
         VALUES (?, 'location', 'X', NULL, ?, ?)`,
        [newId(), CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(db, { name: 'tags', pk: 'id' }))[0]!
      const dataLine = csv.split('\n')[1]!
      expect(dataLine.split(',').some((c) => c === '')).toBe(true)
    })
  })

  describe('exportTableToCsvFiles chunking', () => {
    const tagsTable = { name: 'tags', pk: 'id' }
    const dataRows = (csv: string) =>
      Papa.parse<string[]>(csv, { skipEmptyLines: true }).data.slice(1)
    const header = (csv: string) => Papa.parse<string[]>(csv).data[0]!

    it('splits 1001 rows into 1000 + 1, each with the header', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await seedTags(db, 1001)
      const files = await exportTableToCsvFiles(db, tagsTable)
      expect(files).toHaveLength(2)
      expect(dataRows(files[0]!)).toHaveLength(1000)
      expect(dataRows(files[1]!)).toHaveLength(1)
      expect(header(files[0]!)[0]).toBe('id')
      expect(header(files[1]!)).toEqual(header(files[0]!))
    })

    it('keeps exactly 1000 rows in one file', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await seedTags(db, 1000)
      expect(await exportTableToCsvFiles(db, tagsTable)).toHaveLength(1)
    })

    it('gives an empty table one header-only file', async () => {
      const db = await migratedDb()
      dbs.push(db)
      const files = await exportTableToCsvFiles(db, tagsTable)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^id,kind,name,[^\n]*\n$/)
    })

    it('a multi-line, quoted row at a file boundary round-trips', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      await seedTags(src, 1001, (n) => (n >= 1000 ? 'line1\nline2, "q"' : null))
      await importAllTables(dst, await exportAllTables(src))
      expect(await hashDatabase(dst)).toBe(await hashDatabase(src))
    })
  })

  describe('importCsvIntoTable', () => {
    it('round-trips a seeded row exactly', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      const id = newId()
      await src.run(
        `INSERT INTO tags (id, kind, name, description, synonyms, colour, icon,
                           created_at_utc, updated_at_utc)
         VALUES (?, 'location', 'Home', 'Berlin, DE', '["a","b"]', '#22c55e', 'home', ?, ?)`,
        [id, CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(src, { name: 'tags', pk: 'id' }))[0]!
      await importCsvIntoTable(dst, { name: 'tags', pk: 'id' }, csv)
      const srcRows = await src.exec<Record<string, unknown>>('SELECT * FROM tags')
      const dstRows = await dst.exec<Record<string, unknown>>('SELECT * FROM tags')
      expect(dstRows).toHaveLength(srcRows.length)
      expect(rowsEqual(srcRows[0]!, dstRows[0]!)).toBe(true)
    })

    it('coerces INTEGER and REAL columns to numbers (not strings)', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      const tagId = newId()
      for (const db of [src, dst]) {
        await db.run(
          `INSERT INTO tags (id, kind, name, created_at_utc, updated_at_utc)
           VALUES (?, 'location', 'GPS', ?, ?)`,
          [tagId, CUTOFF, CUTOFF],
        )
      }
      await src.run(
        `INSERT INTO location_details (tag_id, latitude, longitude, created_at_utc, updated_at_utc)
         VALUES (?, 52.5, 13.4, ?, ?)`,
        [tagId, CUTOFF, CUTOFF],
      )
      const details = { name: 'location_details', pk: 'tag_id' }
      const csv = (await exportTableToCsvFiles(src, details))[0]!
      await importCsvIntoTable(dst, details, csv)
      const row = (
        await dst.exec<{ latitude: unknown; longitude: unknown }>(
          'SELECT latitude, longitude FROM location_details',
        )
      )[0]!
      expect(typeof row.latitude).toBe('number')
      expect(row.latitude).toBeCloseTo(52.5)
    })

    it('coerces empty cells in nullable columns to NULL', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      await src.run(
        `INSERT INTO tags (id, kind, name, description, created_at_utc, updated_at_utc)
         VALUES (?, 'location', 'X', NULL, ?, ?)`,
        [newId(), CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(src, { name: 'tags', pk: 'id' }))[0]!
      await importCsvIntoTable(dst, { name: 'tags', pk: 'id' }, csv)
      const row = (await dst.exec<{ description: unknown }>('SELECT description FROM tags'))[0]!
      expect(row.description).toBeNull()
    })

    it('preserves a JSON-literal cell (synonyms array)', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      await src.run(
        `INSERT INTO tags (id, kind, name, synonyms, created_at_utc, updated_at_utc)
         VALUES (?, 'location', 'X', ?, ?, ?)`,
        [newId(), '["a","b","c"]', CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(src, { name: 'tags', pk: 'id' }))[0]!
      await importCsvIntoTable(dst, { name: 'tags', pk: 'id' }, csv)
      const row = (await dst.exec<{ synonyms: string }>('SELECT synonyms FROM tags'))[0]!
      expect(JSON.parse(row.synonyms)).toEqual(['a', 'b', 'c'])
    })

    it('imports nothing from an empty CSV (header only)', async () => {
      const dst = await migratedDb()
      dbs.push(dst)
      const headerOnly = (await exportTableToCsvFiles(dst, { name: 'tags', pk: 'id' }))[0]!
      await importCsvIntoTable(dst, { name: 'tags', pk: 'id' }, headerOnly)
      expect(await dst.exec('SELECT * FROM tags')).toHaveLength(0)
    })
  })

  describe('exportAllTables / importAllTables (round-trip)', () => {
    it('round-trips a DB with rows in every table', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      const locId = newId()
      const accId = newId()
      await src.run(
        `INSERT INTO tags (id, kind, name, synonyms, created_at_utc, updated_at_utc)
         VALUES (?, 'location', 'Home', '[]', ?, ?)`,
        [locId, CUTOFF, CUTOFF],
      )
      const foodId = newId()
      const reweId = newId()
      const tripId = newId()
      await src.run(
        `INSERT INTO tags (id, kind, name, description, synonyms, colour, icon,
                           created_at_utc, updated_at_utc)
         VALUES (?, 'category', 'Food', NULL, '["Essen"]', '#00ff00', 'tag', ?, ?),
                (?, 'merchant', 'Rewe', 'Supermarket', '[]', NULL, NULL, ?, ?),
                (?, 'journey', 'Lisbon', NULL, '[]', NULL, 'globe', ?, ?)`,
        [foodId, CUTOFF, CUTOFF, reweId, CUTOFF, CUTOFF, tripId, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO location_details (tag_id, address, latitude, longitude, merchant_id,
                                       created_at_utc, updated_at_utc)
         VALUES (?, 'Alexanderplatz 1', 52.5219, 13.4132, ?, ?, ?)`,
        [locId, reweId, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO merchant_details (tag_id, default_category_id, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?)`,
        [reweId, foodId, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO journey_details (tag_id, start_date, end_date, created_at_utc, updated_at_utc)
         VALUES (?, '2026-07-01', NULL, ?, ?)`,
        [tripId, CUTOFF, CUTOFF],
      )
      const groupingId = newId()
      await src.run(
        `INSERT INTO account_groupings (id, name, colour, icon, sort_order, created_at_utc, updated_at_utc)
         VALUES (?, 'Cash', '#ffffff', 'group', 3, ?, ?)`,
        [groupingId, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, is_cash, location_id,
                               colour, icon, grouping_id, sort_order, created_at_utc, updated_at_utc)
         VALUES (?, 'Checking', 'USD', 0, 2, 1, ?, '#000000', 'wallet', ?, 7, ?, ?)`,
        [accId, locId, groupingId, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO applied_rates (id, date, currency_a, currency_b, rate, provider, via,
                                    reference_date, created_at_utc, updated_at_utc)
         VALUES (?, '2026-05-01', 'EUR', 'USD', 1.0842, 'fawazahmed0+bank', 'GBP', '2026-04-30', ?, ?),
                (?, '2026-05-01', 'EUR', 'MILES', NULL, NULL, NULL, NULL, ?, ?)`,
        [newId(), CUTOFF, CUTOFF, newId(), CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO transactions
           (id, account_id__from, account_id__to,
            amount_value__from, amount_scale__from, amount_currency__from,
            amount_value__to, amount_scale__to, amount_currency__to,
            transaction_at_local, transaction_at_zone,
            description__user, description__auto,
            created_at_utc, updated_at_utc)
         VALUES (?, ?, NULL, 100, 2, 'USD', 100, 2, 'USD',
                 '2026-05-01T09:00:00.000+00:00', 'UTC', ?, ?, ?, ?)`,
        [
          newId(),
          accId,
          'Lunch, "the usual"\nwith Anna',
          '{"source":"ocr","raw":"MENU 1,00\\n\\"Bar\\""}',
          CUTOFF,
          CUTOFF,
        ],
      )
      const bundle = await exportAllTables(src)
      for (const t of SYNC_TABLES) {
        expect(bundle.has(t.name), `bundle missing ${t.name}`).toBe(true)
      }
      await importAllTables(dst, bundle)
      for (const t of SYNC_TABLES) {
        const srcRows = await src.exec<Record<string, unknown>>(
          `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
        )
        const dstRows = await dst.exec<Record<string, unknown>>(
          `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
        )
        expect(dstRows.length, `row count mismatch on ${t.name}`).toBe(srcRows.length)
        for (let i = 0; i < srcRows.length; i++) {
          expect(rowsEqual(srcRows[i]!, dstRows[i]!), `row mismatch on ${t.name}[${i}]`).toBe(true)
        }
      }
    })

    it('imports a child tag from an earlier CSV file than its parent', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      // The child's id sorts first, so with one row per file it lands in the
      // first file and its parent in the second.
      await seedTag(src, {
        id: 'b-parent',
        name: 'Food',
        kind: 'category',
        created: CUTOFF,
        updated: CUTOFF,
      })
      await seedTag(src, {
        id: 'a-child',
        name: 'Fruit',
        kind: 'category',
        parentId: 'b-parent',
        created: CUTOFF,
        updated: CUTOFF,
      })
      const bundle = await exportAllTables(src, 1)
      expect(bundle.get('tags')).toHaveLength(2)

      await importAllTables(dst, bundle)

      expect(await dst.exec('SELECT id, parent_id FROM tags ORDER BY id')).toEqual([
        { id: 'a-child', parent_id: 'b-parent' },
        { id: 'b-parent', parent_id: null },
      ])
    })

    it('rolls back the destination on an FK violation mid-import', async () => {
      const dst = await migratedDb()
      dbs.push(dst)
      const bundle = new Map<string, string[]>()
      // Empty parents but a transaction referencing a non-existent account.
      // exportTableToCsvFiles on an empty dst gives us header-only CSVs for the
      // tables that aren't transactions.
      for (const t of SYNC_TABLES) {
        bundle.set(t.name, await exportTableToCsvFiles(dst, t))
      }
      const txnHeader = bundle.get('transactions')![0]!
      bundle.set('transactions', [
        txnHeader +
          `${newId()},missing-account,,100,2,USD,100,2,USD,2026-05-01T09:00:00.000+00:00,UTC,,,[],,,,,,${CUTOFF},${CUTOFF},\n`,
      ])
      await expect(importAllTables(dst, bundle)).rejects.toThrow()
      // Other tables also imported nothing — everything rolled back.
      for (const t of SYNC_TABLES) {
        expect(await dst.exec(`SELECT * FROM ${t.name}`)).toHaveLength(0)
      }
    })
  })
})
