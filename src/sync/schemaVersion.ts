import type { Database } from '../db/Database'

/** What to do about a schema-version difference before merging. */
export type SchemaAction = 'merge' | 'migrate-remote-then-merge' | 'abort-app-outdated'

/** Highest applied migration version in `db`, or 0 if none applied. */
export async function readSchemaVersion(db: Database): Promise<number> {
  const rows = await db.exec<{ v: number | null }>('SELECT MAX(version) AS v FROM migrations')
  return rows[0]?.v ?? 0
}

/**
 * Decide the schema gate (algorithm step 3):
 *  - remote newer than this app  → abort, the user must update the app
 *  - remote older                → migrate the downloaded copy, then merge
 *  - equal                       → merge directly
 */
export function decideSchemaAction(localVersion: number, remoteVersion: number): SchemaAction {
  if (remoteVersion > localVersion) return 'abort-app-outdated'
  if (remoteVersion < localVersion) return 'migrate-remote-then-merge'
  return 'merge'
}
