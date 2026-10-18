import type { Database } from '../db/Database'
import type { BlobTransport } from './BlobTransport'
import { exportDatabaseToBlob, openDatabaseFromBlob } from './sqliteBlobCodec'
import { hashDatabase } from './hashDatabase'
import type { SyncBackend } from './SyncBackend'
import type { SyncMetadata } from './types'

/**
 * SyncBackend that stores the database as a single .sqlite blob plus a
 * metadata sidecar (db.sqlite.json). CAS via the sidecar's ETag — see
 * BlobTransport. Used by Supabase Storage and S3-compatible transports.
 *
 * Sequencing for tryUpload:
 *  1. Put the new blob (no CAS — alone, it means nothing).
 *  2. Put the new sidecar with If-Match: <expected etag>. 412 = CAS miss.
 *
 * KNOWN HAZARD (postponed, see TASKS.md): the blob lives under a fixed key,
 * so step 1 is not harmless. When step 2 loses the race, step 1 has already
 * overwritten the WINNER's blob, while the sidecar still describes the
 * winner. The loser's retry then downloads its own data, merges nothing and
 * uploads over it with a passing CAS: the winner's changes vanish from the
 * remote (they survive only on the winner's device until it syncs again).
 * Intended fix: write each blob under its own content-addressed key
 * (e.g. `db-<hash>.sqlite`, create-only), let the sidecar name the current
 * key so the sidecar CAS is the only contested write, and verify the
 * downloaded blob's hash against the sidecar's hash.
 *
 * Contract notes:
 *  - getMetadata() caches the current sidecar ETag as the CAS handle for
 *    the next tryUpload(). The cache is on this instance only, so a fresh
 *    SqliteBlobBackend must call getMetadata() before its first tryUpload
 *    — verified by test. Calling tryUpload without prior getMetadata throws
 *    unconditionally, making the CAS contract legible in test code.
 *  - downloadDatabase() returns a fresh in-memory Database with the synced
 *    blob opened directly via openDatabaseFromBlob.
 *  - tryUpload exports the entire database on every call (full blob upload
 *    — see the design doc's "Assumptions accepted on purpose" for why this
 *    is acceptable at personal-finance scale).
 */
export class SqliteBlobBackend implements SyncBackend {
  private cachedSidecarEtag: string | null = null
  private getMetadataCalled = false

  constructor(private readonly transport: BlobTransport) {}

  async getMetadata(): Promise<SyncMetadata | null> {
    this.getMetadataCalled = true
    const sidecar = await this.transport.getSidecar()
    if (!sidecar) {
      this.cachedSidecarEtag = null
      return null
    }
    this.cachedSidecarEtag = sidecar.etag
    return JSON.parse(sidecar.text) as SyncMetadata
  }

  async downloadDatabase(): Promise<Database> {
    const bytes = await this.transport.getBlob()
    return openDatabaseFromBlob(bytes)
  }

  async hashDatabase(db: Database): Promise<string> {
    return hashDatabase(db)
  }

  async tryUpload(
    localDb: Database,
    metadata: SyncMetadata,
    expected: SyncMetadata | null,
  ): Promise<boolean> {
    if (!this.getMetadataCalled) {
      throw new Error(
        'SqliteBlobBackend.tryUpload called without prior getMetadata — the backend needs the cached sidecar etag',
      )
    }
    const blob = await exportDatabaseToBlob(localDb)
    // TODO(postponed): unconditional write to the fixed blob key BEFORE the
    // CAS — a lost race overwrites the winner's blob. See the class comment.
    await this.transport.putBlob(blob)
    const ok = await this.transport.putSidecar(
      JSON.stringify(metadata) + '\n',
      expected === null ? null : this.cachedSidecarEtag,
    )
    if (ok) {
      // Re-read to capture the new etag for next call's CAS handle.
      const sidecar = await this.transport.getSidecar()
      this.cachedSidecarEtag = sidecar?.etag ?? null
    }
    return ok
  }
}
