import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { readSchemaVersion, decideSchemaAction } from '../schemaVersion'

describe('readSchemaVersion', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('returns 0 for a database with no migrations applied', async () => {
    db = new Database()
    await db.init()
    await db.run(
      'CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL)',
    )
    expect(await readSchemaVersion(db)).toBe(0)
  })

  it('returns the highest applied migration version', async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    expect(await readSchemaVersion(db)).toBe(2)
  })
})

describe('decideSchemaAction', () => {
  it('merges directly when versions match', () => {
    expect(decideSchemaAction(2, 2)).toBe('merge')
  })

  it('migrates the remote copy when it is older', () => {
    expect(decideSchemaAction(3, 2)).toBe('migrate-remote-then-merge')
  })

  it('aborts when the remote is newer than this app', () => {
    expect(decideSchemaAction(2, 3)).toBe('abort-app-outdated')
  })
})
