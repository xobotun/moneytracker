import type { Database } from '../Database'
import { migration as settingsMigration } from './001_settings'
import { migration as domainMigration } from './002_domain_schema'

export interface Migration {
  version: number
  up: string
}

/**
 * Authoritative, ordered list of every migration. Both init.ts (bringing the
 * local DB up to the latest schema) and GitHubCsvBackend.downloadDatabase
 * (bringing a fresh in-memory DB up to a remote snapshot's schema version)
 * must use this single list — a second, independently maintained copy would
 * silently drift the moment a new migration is added to only one of them.
 */
export const ALL_MIGRATIONS: Migration[] = [settingsMigration, domainMigration]

export async function runMigrations(db: Database, migrations: Migration[]): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at_utc TEXT NOT NULL
    )
  `)

  const applied = await db.exec<{ version: number }>('SELECT version FROM migrations')
  const appliedVersions = new Set(applied.map((r) => r.version))

  const sorted = [...migrations].sort((a, b) => a.version - b.version)

  for (const migration of sorted) {
    if (appliedVersions.has(migration.version)) continue
    await db.transaction(async (tx) => {
      await tx.run(migration.up)
      await tx.run('INSERT INTO migrations (version, applied_at_utc) VALUES (?, ?)', [
        migration.version,
        new Date().toISOString(),
      ])
    })
  }
}
