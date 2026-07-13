import type { Database } from '../db/Database'
import type { SyncMetadata } from './types'

/**
 * The single seam between the sync orchestrator and the world. One concrete
 * backend per provider:
 *   - GitHubCsvBackend stores CSV-per-table inside a git repo.
 *   - SqliteBlobBackend stores a single .sqlite blob plus a metadata sidecar
 *     (used by Supabase Storage and S3-compatible transports).
 *
 * Whether the backend stores one file or many is its private detail. The
 * orchestrator only sees Database-level operations.
 *
 * Contract notes:
 *  - getMetadata() may have a side effect: caches whatever CAS handle the
 *    next tryUpload() needs (e.g., the current branch HEAD commit SHA for
 *    GitHub, the metadata sidecar's ETag for S3).
 *  - tryUpload() requires a prior getMetadata() — calling it cold is a
 *    programming error and the backend should throw.
 *  - downloadDatabase() returns a freshly-opened in-memory Database. The
 *    caller owns the lifecycle and closes it after use.
 *  - hashDatabase(db) is provider-independent (delegates to the shared
 *    hashDatabase function). It is on the interface only so test code can
 *    use whatever backend it has without reaching into the helper module.
 */
export interface SyncBackend {
  /** Current remote metadata, or null when nothing has ever been uploaded. */
  getMetadata(): Promise<SyncMetadata | null>

  /** Downloads the remote database into a fresh in-memory Database. Caller closes it. */
  downloadDatabase(): Promise<Database>

  /** Content hash of `db` — same logical DB yields the same hash across backends. */
  hashDatabase(db: Database): Promise<string>

  /**
   * CAS upload. Exports `localDb` and writes it; succeeds only if the
   * current remote metadata still equals `expected` (both null for the
   * first upload). Returns false on CAS miss — the orchestrator then re-
   * merges. Throws if called without a prior getMetadata().
   */
  tryUpload(
    localDb: Database,
    metadata: SyncMetadata,
    expected: SyncMetadata | null,
  ): Promise<boolean>
}

/** True when two metadata values are equal for the purpose of the CAS check. */
export function metadataEquals(a: SyncMetadata | null, b: SyncMetadata | null): boolean {
  if (a === null || b === null) return a === b
  return a.device === b.device && a.uploadedAtUtc === b.uploadedAtUtc && a.hash === b.hash
}
