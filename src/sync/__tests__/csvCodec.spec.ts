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
import { seedLocations } from './helpers'
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
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'Two', '[]', ?, ?)`,
        [id2, CUTOFF, CUTOFF],
      )
      await db.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'One', '[]', ?, ?)`,
        [id1, CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(db, { name: 'locations', pk: 'id' }))[0]!
      const lines = csv.split('\n').filter((l) => l.length > 0)
      expect(lines[0]).toMatch(/^id,name,/)
      expect(lines[1]!).toContain(id1)
      expect(lines[2]!).toContain(id2)
    })

    it('quotes commas, double quotes, and embedded newlines per RFC 4180', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await db.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, ?, '[]', ?, ?)`,
        [newId(), 'Smith, "Jr."\nNYC', CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(db, { name: 'locations', pk: 'id' }))[0]!
      // The Name cell should be quoted; the embedded double quote should
      // be doubled; the embedded newline should sit inside the quoted cell.
      expect(csv).toMatch(/"Smith, ""Jr\.""\nNYC"/)
    })

    it('emits NULL as an empty cell', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await db.run(
        `INSERT INTO locations (id, name, city, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'X', NULL, '[]', ?, ?)`,
        [newId(), CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(db, { name: 'locations', pk: 'id' }))[0]!
      const dataLine = csv.split('\n')[1]!
      expect(dataLine.split(',').some((c) => c === '')).toBe(true)
    })
  })

  describe('exportTableToCsvFiles chunking', () => {
    const locations = { name: 'locations', pk: 'id' }
    const dataRows = (csv: string) =>
      Papa.parse<string[]>(csv, { skipEmptyLines: true }).data.slice(1)
    const header = (csv: string) => Papa.parse<string[]>(csv).data[0]!

    it('splits 1001 rows into 1000 + 1, each with the header', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await seedLocations(db, 1001)
      const files = await exportTableToCsvFiles(db, locations)
      expect(files).toHaveLength(2)
      expect(dataRows(files[0]!)).toHaveLength(1000)
      expect(dataRows(files[1]!)).toHaveLength(1)
      expect(header(files[0]!)[0]).toBe('id')
      expect(header(files[1]!)).toEqual(header(files[0]!))
    })

    it('keeps exactly 1000 rows in one file', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await seedLocations(db, 1000)
      expect(await exportTableToCsvFiles(db, locations)).toHaveLength(1)
    })

    it('gives an empty table one header-only file', async () => {
      const db = await migratedDb()
      dbs.push(db)
      const files = await exportTableToCsvFiles(db, locations)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^id,name,[^\n]*\n$/)
    })

    it('a multi-line, quoted row at a file boundary round-trips', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      await seedLocations(src, 1001, (n) => (n >= 1000 ? 'line1\nline2, "q"' : null))
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
        `INSERT INTO locations (id, name, city, country, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'Home', 'Berlin', 'DE', '["a","b"]', ?, ?)`,
        [id, CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(src, { name: 'locations', pk: 'id' }))[0]!
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, csv)
      const srcRows = await src.exec<Record<string, unknown>>('SELECT * FROM locations')
      const dstRows = await dst.exec<Record<string, unknown>>('SELECT * FROM locations')
      expect(dstRows).toHaveLength(srcRows.length)
      expect(rowsEqual(srcRows[0]!, dstRows[0]!)).toBe(true)
    })

    it('coerces INTEGER and REAL columns to numbers (not strings)', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      await src.run(
        `INSERT INTO locations (id, name, latitude, longitude, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'GPS', 52.5, 13.4, '[]', ?, ?)`,
        [newId(), CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(src, { name: 'locations', pk: 'id' }))[0]!
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, csv)
      const row = (
        await dst.exec<{ latitude: unknown; longitude: unknown }>(
          'SELECT latitude, longitude FROM locations',
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
        `INSERT INTO locations (id, name, city, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'X', NULL, '[]', ?, ?)`,
        [newId(), CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(src, { name: 'locations', pk: 'id' }))[0]!
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, csv)
      const row = (await dst.exec<{ city: unknown }>('SELECT city FROM locations'))[0]!
      expect(row.city).toBeNull()
    })

    it('preserves a JSON-literal cell (tags array)', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      await src.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'X', ?, ?, ?)`,
        [newId(), '["a","b","c"]', CUTOFF, CUTOFF],
      )
      const csv = (await exportTableToCsvFiles(src, { name: 'locations', pk: 'id' }))[0]!
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, csv)
      const row = (await dst.exec<{ tags: string }>('SELECT tags FROM locations'))[0]!
      expect(JSON.parse(row.tags)).toEqual(['a', 'b', 'c'])
    })

    it('imports nothing from an empty CSV (header only)', async () => {
      const dst = await migratedDb()
      dbs.push(dst)
      const headerOnly = (await exportTableToCsvFiles(dst, { name: 'locations', pk: 'id' }))[0]!
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, headerOnly)
      expect(await dst.exec('SELECT * FROM locations')).toHaveLength(0)
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
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'Home', '[]', ?, ?)`,
        [locId, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO tags (tag, description, synonyms, colour, icon, created_at_utc, updated_at_utc)
         VALUES (?, NULL, '[]', '#00ff00', 'tag', ?, ?)`,
        ['food', CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, location_id,
                               colour, icon, created_at_utc, updated_at_utc)
         VALUES (?, 'Checking', 'USD', 0, 2, ?, '#000000', 'wallet', ?, ?)`,
        [accId, locId, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO exchange_rates (id, date, base_currency, rates, provider,
                                     created_at_utc, updated_at_utc)
         VALUES (?, ?, 'USD', '{"EUR":0.92}', 'oer', ?, ?)`,
        [newId(), CUTOFF, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO account_groupings (id, name, colour, icon, accounts_ids, created_at_utc, updated_at_utc)
         VALUES (?, 'Cash', '#ffffff', 'group', ?, ?, ?)`,
        [newId(), JSON.stringify([accId]), CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO transactions
           (id, account_id__from, account_id__to,
            amount_value__from, amount_scale__from, amount_currency__from,
            amount_value__to, amount_scale__to, amount_currency__to,
            transaction_at_local, transaction_at_zone,
            created_at_utc, updated_at_utc)
         VALUES (?, ?, NULL, 100, 2, 'USD', 100, 2, 'USD',
                 '2026-05-01T09:00:00.000+00:00', 'UTC', ?, ?)`,
        [newId(), accId, CUTOFF, CUTOFF],
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
          `${newId()},missing-account,,100,2,USD,100,2,USD,2026-05-01T09:00:00.000+00:00,UTC,,,[],,,,${CUTOFF},${CUTOFF},\n`,
      ])
      await expect(importAllTables(dst, bundle)).rejects.toThrow()
      // Other tables also imported nothing — everything rolled back.
      for (const t of SYNC_TABLES) {
        expect(await dst.exec(`SELECT * FROM ${t.name}`)).toHaveLength(0)
      }
    })
  })
})
