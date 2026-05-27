import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { readRows, rowsEqual, isDeleted, effectiveTimestamp, changedSince, upsertRow } from '../rows'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

describe('row helpers', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('readRows returns every row of a table', async () => {
    db = await migratedDb()
    await db.run(
      'INSERT INTO locations (id, name, created_at_utc, updated_at_utc) VALUES (?, ?, ?, ?)',
      ['loc-1', 'Home', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'],
    )
    const rows = await readRows(db, 'locations')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('loc-1')
  })

  it('rowsEqual compares all columns', () => {
    expect(rowsEqual({ id: 'a', name: 'X' }, { id: 'a', name: 'X' })).toBe(true)
    expect(rowsEqual({ id: 'a', name: 'X' }, { id: 'a', name: 'Y' })).toBe(false)
  })

  it('rowsEqual compares Uint8Array (BLOB) values byte-by-byte', () => {
    // wa-sqlite returns BLOB columns as Uint8Array, so strict equality would
    // always declare two equal-content blobs different.
    expect(
      rowsEqual({ id: 'a', b: new Uint8Array([1, 2, 3]) }, { id: 'a', b: new Uint8Array([1, 2, 3]) }),
    ).toBe(true)
    expect(
      rowsEqual({ id: 'a', b: new Uint8Array([1, 2, 3]) }, { id: 'a', b: new Uint8Array([1, 2, 4]) }),
    ).toBe(false)
    expect(
      rowsEqual({ id: 'a', b: new Uint8Array([1, 2]) }, { id: 'a', b: new Uint8Array([1, 2, 3]) }),
    ).toBe(false)
  })

  it('isDeleted reflects deleted_at_utc', () => {
    expect(isDeleted({ deleted_at_utc: null })).toBe(false)
    expect(isDeleted({ deleted_at_utc: '2026-05-01T00:00:00.000Z' })).toBe(true)
  })

  it('effectiveTimestamp prefers deleted_at_utc over updated_at_utc', () => {
    expect(
      effectiveTimestamp({ updated_at_utc: '2026-05-01T00:00:00.000Z', deleted_at_utc: null }),
    ).toBe('2026-05-01T00:00:00.000Z')
    expect(
      effectiveTimestamp({
        updated_at_utc: '2026-05-01T00:00:00.000Z',
        deleted_at_utc: '2026-05-02T00:00:00.000Z',
      }),
    ).toBe('2026-05-02T00:00:00.000Z')
  })

  it('changedSince is true when any timestamp is newer than the cutoff', () => {
    const cutoff = '2026-05-01T00:00:00.000Z'
    expect(
      changedSince(
        { created_at_utc: '2026-04-01T00:00:00.000Z', updated_at_utc: '2026-06-01T00:00:00.000Z', deleted_at_utc: null },
        cutoff,
      ),
    ).toBe(true)
    expect(
      changedSince(
        { created_at_utc: '2026-04-01T00:00:00.000Z', updated_at_utc: '2026-04-01T00:00:00.000Z', deleted_at_utc: null },
        cutoff,
      ),
    ).toBe(false)
  })

  it('upsertRow inserts a new row and overwrites an existing one', async () => {
    db = await migratedDb()
    const row = {
      id: 'loc-9',
      name: 'First',
      description: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      tags: '[]',
      created_at_utc: '2026-05-01T00:00:00.000Z',
      updated_at_utc: '2026-05-01T00:00:00.000Z',
      deleted_at_utc: null,
    }
    await upsertRow(db, 'locations', 'id', row)
    await upsertRow(db, 'locations', 'id', { ...row, name: 'Second' })
    const rows = await readRows(db, 'locations')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Second')
  })
})
