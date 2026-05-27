import type { Database } from '../db/Database'

/**
 * Serializes a `Database` to an uploadable blob and back. The real
 * implementation (`VACUUM INTO` + `MemoryVFS`, see the `reference_sqlite_export`
 * memory) lands in the follow-up plan; the orchestrator depends only on this
 * interface so it stays unit-testable.
 */
export interface DatabaseCodec {
  /** Serialize a database to a blob suitable for upload. */
  export(db: Database): Promise<Blob>

  /** Open a fresh `Database` from a downloaded blob. Caller closes it. */
  openFromBlob(blob: Blob): Promise<Database>

  /** A stable hash of a blob — equal blobs hash equal. */
  hash(blob: Blob): Promise<string>
}
