import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { exportDatabaseToBlob, openDatabaseFromBlob } from '../sqliteBlobCodec'
import { rowsEqual } from '../rows'
import { SYNC_TABLES } from '../syncTables'
import { newId } from '../../db/uuid'
import { hashDatabase } from '../hashDatabase'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

const CUTOFF = '2026-05-01T00:00:00.000Z'

describe('sqliteBlobCodec', () => {
  let dbs: Database[] = []
  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
  })

  it('export returns a non-empty Uint8Array', async () => {
    const db = await migratedDb()
    dbs.push(db)
    const blob = await exportDatabaseToBlob(db)
    expect(blob).toBeInstanceOf(Uint8Array)
    expect(blob.length).toBeGreaterThan(0)
    // SQLite header: first 16 bytes are "SQLite format 3\0".
    const header = new TextDecoder().decode(blob.slice(0, 15))
    expect(header).toBe('SQLite format 3')
  })

  it('round-trips a seeded database byte-for-byte (every row in every table)', async () => {
    const src = await migratedDb()
    dbs.push(src)
    const locId = newId()
    const accId = newId()
    await src.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'Home', '["a","b"]', ?, ?, ?)`,
      [locId, CUTOFF, CUTOFF, CUTOFF],
    )
    await src.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, location_id,
                             colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, 'Checking', 'USD', 100, 2, ?, '#000000', 'wallet', ?, ?)`,
      [accId, locId, CUTOFF, CUTOFF],
    )
    const blob = await exportDatabaseToBlob(src)

    const dst = await openDatabaseFromBlob(blob)
    dbs.push(dst)

    for (const t of SYNC_TABLES) {
      const a = await src.exec<Record<string, unknown>>(`SELECT * FROM ${t.name} ORDER BY ${t.pk}`)
      const b = await dst.exec<Record<string, unknown>>(`SELECT * FROM ${t.name} ORDER BY ${t.pk}`)
      expect(b.length, t.name).toBe(a.length)
      for (let i = 0; i < a.length; i++) {
        expect(rowsEqual(a[i]!, b[i]!), `${t.name}[${i}]`).toBe(true)
      }
    }
  })

  it('hashDatabase(roundTripped) === hashDatabase(original)', async () => {
    const src = await migratedDb()
    dbs.push(src)
    await src.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'X', '[]', ?, ?, ?)`,
      [newId(), CUTOFF, CUTOFF, CUTOFF],
    )
    const hSrc = await hashDatabase(src)
    const blob = await exportDatabaseToBlob(src)
    const dst = await openDatabaseFromBlob(blob)
    dbs.push(dst)
    expect(await hashDatabase(dst)).toBe(hSrc)
  })

  it('exportDatabaseToBlob does not bump the source mutationCounter', async () => {
    const db = await migratedDb()
    dbs.push(db)
    await db.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'X', '[]', ?, ?, ?)`,
      [newId(), CUTOFF, CUTOFF, CUTOFF],
    )
    const before = db.mutationCounter
    await exportDatabaseToBlob(db)
    // VACUUM INTO writes to a separate target file. The source's counter
    // should not advance.
    expect(db.mutationCounter).toBe(before)
  })
})
