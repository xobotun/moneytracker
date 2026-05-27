import { Database } from '../../db/Database'
import type { SyncProvider } from '../SyncProvider'
import type { DatabaseCodec } from '../DatabaseCodec'
import type { SyncMetadata } from '../types'
import { metadataEquals } from '../SyncProvider'
import { SYNC_TABLES } from '../syncTables'
import { readRows, upsertRow } from '../rows'
import { newMigratedDb } from './helpers'

/** In-memory SyncProvider with real compare-and-swap semantics. */
export class FakeSyncProvider implements SyncProvider {
  private blob: Blob | null = null
  private meta: SyncMetadata | null = null

  /** Test hook: runs inside upload(), before the CAS check, to simulate a
   *  concurrent upload by another device. Set it, then it fires once. */
  beforeUpload: (() => Promise<void>) | null = null

  async getMetadata(): Promise<SyncMetadata | null> {
    return this.meta
  }

  async download(): Promise<Blob> {
    if (!this.blob) throw new Error('FakeSyncProvider: nothing uploaded yet')
    return this.blob
  }

  async upload(blob: Blob, metadata: SyncMetadata, expected: SyncMetadata | null): Promise<boolean> {
    if (this.beforeUpload) {
      const hook = this.beforeUpload
      this.beforeUpload = null
      await hook()
    }
    if (!metadataEquals(this.meta, expected)) return false
    this.blob = blob
    this.meta = metadata
    return true
  }

  /** Test helper: force remote state without a CAS check. */
  forceState(blob: Blob, metadata: SyncMetadata): void {
    this.blob = blob
    this.meta = metadata
  }
}

/**
 * DatabaseCodec that serializes the sync tables to JSON. Good enough for tests
 * and a valid (if unoptimized) implementation; the follow-up plan replaces it
 * with a `VACUUM INTO`-based codec that preserves the whole .sqlite file.
 */
export class FakeDatabaseCodec implements DatabaseCodec {
  async export(db: Database): Promise<Blob> {
    const dump: Record<string, unknown[]> = {}
    for (const table of SYNC_TABLES) {
      dump[table.name] = await readRows(db, table.name)
    }
    return new Blob([JSON.stringify(dump)], { type: 'application/json' })
  }

  async openFromBlob(blob: Blob): Promise<Database> {
    const dump = JSON.parse(await blob.text()) as Record<string, Record<string, unknown>[]>
    const db = await newMigratedDb()
    for (const table of SYNC_TABLES) {
      for (const row of dump[table.name] ?? []) {
        await upsertRow(db, table.name, table.pk, row)
      }
    }
    return db
  }

  async hash(blob: Blob): Promise<string> {
    // FNV-1a over the blob text — deterministic, dependency-free.
    const text = await blob.text()
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16)
  }
}
