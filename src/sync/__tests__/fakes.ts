import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { hashDatabase } from '../hashDatabase'
import type { SyncBackend } from '../SyncBackend'
import type { SyncMetadata } from '../types'

/**
 * In-memory SyncBackend for unit tests. Holds an open Database directly as
 * the "remote state" — no codec round-trip needed, no transport simulated.
 * The tests that exercise the real CSV and blob codecs live in their own
 * spec files; this fake is exclusively for the orchestrator suite.
 */
export class FakeSyncBackend implements SyncBackend {
  private remoteDb: Database | null = null
  private remoteMeta: SyncMetadata | null = null
  /** Stub for the CAS handle the real backends cache from getMetadata(). */
  private metadataReadAt: SyncMetadata | null = null

  /** Test hook: simulate the remote being updated by some other writer. */
  async setRemote(db: Database, meta: SyncMetadata): Promise<void> {
    if (this.remoteDb) await this.remoteDb.close()
    this.remoteDb = db
    this.remoteMeta = meta
  }

  async getMetadata(): Promise<SyncMetadata | null> {
    this.metadataReadAt = this.remoteMeta
    return this.remoteMeta
  }

  async downloadDatabase(): Promise<Database> {
    if (!this.remoteDb) throw new Error('FakeSyncBackend: no remote database')
    // Return a *clone* so the orchestrator's mutations don't leak back into
    // the simulated remote. The cheapest correct clone is: export every row
    // into a fresh migrated DB.
    const clone = new Database()
    await clone.init()
    await runMigrations(clone, [settingsMigration, domainMigration])
    // Copy rows in FK order via the merge engine's helpers. For test
    // simplicity, just re-import via a direct SELECT/INSERT loop per table.
    const { SYNC_TABLES } = await import('../syncTables')
    for (const t of SYNC_TABLES) {
      const rows = await this.remoteDb.exec<Record<string, unknown>>(`SELECT * FROM ${t.name}`)
      for (const row of rows) {
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        await clone.run(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${placeholders})`,
          cols.map((c) => row[c]),
        )
      }
    }
    return clone
  }

  async hashDatabase(db: Database): Promise<string> {
    return hashDatabase(db)
  }

  async tryUpload(
    localDb: Database,
    metadata: SyncMetadata,
    expected: SyncMetadata | null,
  ): Promise<boolean> {
    if (this.metadataReadAt === null && expected !== null) {
      // The orchestrator must have called getMetadata() first.
      throw new Error('FakeSyncBackend.tryUpload called without prior getMetadata')
    }
    // CAS check: current remote must still equal what the caller saw.
    const currentEquals =
      (this.remoteMeta === null && expected === null) ||
      (this.remoteMeta !== null &&
        expected !== null &&
        this.remoteMeta.device === expected.device &&
        this.remoteMeta.uploadedAtUtc === expected.uploadedAtUtc &&
        this.remoteMeta.hash === expected.hash)
    if (!currentEquals) return false

    // Accept the upload: clone localDb into the remote slot the same way
    // downloadDatabase does, so the next download returns a fresh clone too.
    const clone = new Database()
    await clone.init()
    await runMigrations(clone, [settingsMigration, domainMigration])
    const { SYNC_TABLES } = await import('../syncTables')
    for (const t of SYNC_TABLES) {
      const rows = await localDb.exec<Record<string, unknown>>(`SELECT * FROM ${t.name}`)
      for (const row of rows) {
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        await clone.run(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${placeholders})`,
          cols.map((c) => row[c]),
        )
      }
    }
    if (this.remoteDb) await this.remoteDb.close()
    this.remoteDb = clone
    this.remoteMeta = metadata
    return true
  }

  /** Test hook: introspect the simulated remote without going through download. */
  peekMeta(): SyncMetadata | null {
    return this.remoteMeta
  }

  async close(): Promise<void> {
    if (this.remoteDb) await this.remoteDb.close()
    this.remoteDb = null
    this.remoteMeta = null
  }
}
