import type { SyncMetadata } from './types'

/**
 * Remote storage for the database blob and its metadata. The real
 * implementation (Supabase / Backblaze / GitHub) lands in the follow-up plan;
 * the orchestrator and its tests depend only on this interface.
 */
export interface SyncProvider {
  /** Current remote metadata, or null when no database has ever been uploaded. */
  getMetadata(): Promise<SyncMetadata | null>

  /** The current remote database blob. Rejects if nothing has been uploaded. */
  download(): Promise<Blob>

  /**
   * Compare-and-swap upload (algorithm step 8). Succeeds only if the current
   * remote metadata still equals `expected` (both null for the first upload).
   * Returns true on success, false if another device uploaded in the meantime —
   * the orchestrator then re-merges. Never silently clobbers a foreign upload.
   */
  upload(blob: Blob, metadata: SyncMetadata, expected: SyncMetadata | null): Promise<boolean>
}

/** True when two metadata values are equal for the purpose of the CAS check. */
export function metadataEquals(a: SyncMetadata | null, b: SyncMetadata | null): boolean {
  if (a === null || b === null) return a === b
  return a.device === b.device && a.uploadedAtUtc === b.uploadedAtUtc && a.hash === b.hash
}
