import type { Database } from '../Database'

export interface Migration {
  version: number
  up: string
}

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
    await db.run(migration.up)
    await db.run('INSERT INTO migrations (version, applied_at_utc) VALUES (?, ?)', [
      migration.version,
      new Date().toISOString(),
    ])
  }
}
