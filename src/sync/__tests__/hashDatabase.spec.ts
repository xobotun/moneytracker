import { describe, it, expect, afterEach, vi } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { hashDatabase, __resetHashCache } from '../hashDatabase'
import { newId } from '../../db/uuid'
import { seedAccount } from './helpers'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

describe('hashDatabase', () => {
  let dbs: Database[] = []

  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
    __resetHashCache()
  })

  it('returns a sha256:<hex> string', async () => {
    const db = await migratedDb()
    dbs.push(db)
    const h = await hashDatabase(db)
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('returns the same hash for two empty migrated databases', async () => {
    const a = await migratedDb()
    const b = await migratedDb()
    dbs.push(a, b)
    expect(await hashDatabase(a)).toBe(await hashDatabase(b))
  })

  it('returns a different hash after a write', async () => {
    const db = await migratedDb()
    dbs.push(db)
    const before = await hashDatabase(db)
    await db.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'Home', '[]', ?, ?, ?)`,
      [newId(), '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'],
    )
    const after = await hashDatabase(db)
    expect(after).not.toBe(before)
  })

  it('is order-independent within a table (same rows inserted in different orders → same hash)', async () => {
    const a = await migratedDb()
    const b = await migratedDb()
    dbs.push(a, b)
    const id1 = '0193fffffffffffffffffffffffffff1' // smaller PK
    const id2 = '0194000000000000000000000000a002' // larger PK
    // Insert in order id1, id2 into `a`; id2, id1 into `b`. ORDER BY pk
    // in hashDatabase should yield the same sequence either way.
    await a.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'One', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [id1],
    )
    await a.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'Two', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [id2],
    )
    await b.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'Two', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [id2],
    )
    await b.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'One', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [id1],
    )
    expect(await hashDatabase(a)).toBe(await hashDatabase(b))
  })

  it('caches by mutationCounter and does not re-walk on a no-write call', async () => {
    const db = await migratedDb()
    dbs.push(db)
    // First call populates the cache.
    const first = await hashDatabase(db)
    // Spy on db.exec to detect a re-walk on the second call.
    const execSpy = vi.spyOn(db, 'exec')
    const second = await hashDatabase(db)
    expect(second).toBe(first)
    expect(execSpy).not.toHaveBeenCalled()
    execSpy.mockRestore()
  })

  it('invalidates the cache when mutationCounter advances', async () => {
    const db = await migratedDb()
    dbs.push(db)
    const before = await hashDatabase(db)
    await db.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'X', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [newId()],
    )
    const after = await hashDatabase(db)
    expect(after).not.toBe(before)
  })

  it('does not cache a stale hash when a write lands mid-walk', async () => {
    const db = await migratedDb()
    dbs.push(db)
    // Start hashing; the write below queues behind the first table read, so it
    // lands after `tags` was already hashed but before the walk finishes.
    const during = hashDatabase(db)
    await db.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'Home', '[]', ?, ?, ?)`,
      [newId(), '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'],
    )
    const hashMissingTheRow = await during
    // The row is now in the DB, so the next hash must reflect it.
    expect(await hashDatabase(db)).not.toBe(hashMissingTheRow)
  })

  it('ignores cached balances: they are derived from the transactions', async () => {
    const a = await migratedDb()
    const b = await migratedDb()
    dbs.push(a, b)
    for (const db of [a, b]) {
      await seedAccount(db, {
        id: 'acc',
        name: 'Cash',
        created: '2026-05-01T00:00:00.000Z',
        updated: '2026-05-01T00:00:00.000Z',
      })
    }
    await b.run("UPDATE accounts SET balance_value = 999 WHERE id = 'acc'")
    expect(await hashDatabase(a)).toBe(await hashDatabase(b))
  })
})
