import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../Database'
import { runMigrations, type Migration } from '../migrations'

describe('runMigrations', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('creates the migrations table on first run', async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [])
    const rows = await db.exec('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', [
      'table',
      'migrations',
    ])
    expect(rows).toHaveLength(1)
  })

  it('applies migrations in order', async () => {
    db = new Database()
    await db.init()
    const migrations: Migration[] = [
      { version: 1, up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY)' },
      { version: 2, up: 'CREATE TABLE t2 (id INTEGER PRIMARY KEY)' },
    ]
    await runMigrations(db, migrations)
    const tables = await db.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('t1', 't2') ORDER BY name",
    )
    expect(tables.map((t) => t.name)).toEqual(['t1', 't2'])
  })

  it('skips already-applied migrations', async () => {
    db = new Database()
    await db.init()
    const migrations: Migration[] = [{ version: 1, up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY)' }]
    await runMigrations(db, migrations)
    await runMigrations(db, migrations)
    const applied = await db.exec<{ version: number }>('SELECT version FROM migrations')
    expect(applied).toHaveLength(1)
  })

  it('applies only new migrations on second run', async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [{ version: 1, up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY)' }])
    await runMigrations(db, [
      { version: 1, up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY)' },
      { version: 2, up: 'CREATE TABLE t2 (id INTEGER PRIMARY KEY)' },
    ])
    const applied = await db.exec<{ version: number }>(
      'SELECT version FROM migrations ORDER BY version',
    )
    expect(applied.map((r) => r.version)).toEqual([1, 2])
  })

  it('rolls a failing migration back completely and records nothing for it', async () => {
    db = new Database()
    await db.init()
    const failing: Migration = {
      version: 1,
      // First statement succeeds, second fails: the table must not survive.
      up: 'CREATE TABLE half_done (id INTEGER PRIMARY KEY); INSERT INTO no_such_table VALUES (1)',
    }

    await expect(runMigrations(db, [failing])).rejects.toThrow(/no such table/)

    const tables = await db.exec('SELECT name FROM sqlite_master WHERE name = ?', ['half_done'])
    expect(tables).toHaveLength(0)
    expect(await db.exec('SELECT version FROM migrations')).toHaveLength(0)
  })
})
