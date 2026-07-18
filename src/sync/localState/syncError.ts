import { nullableJsonStore } from './storage'

// The last sync error, surfaced in the Settings UI. Cleared on the next
// successful sync. Following the per-concern split convention from the
// rest of this directory.

export interface SyncError {
  /** ISO 8601 UTC instant at which the error was captured. */
  atUtc: string
  /** Human-readable description (usually the Error.message). */
  message: string
}

const slot = nullableJsonStore<SyncError>('lastSyncError')

export function loadSyncError(): SyncError | null {
  return slot.load()
}

export function saveSyncError(err: SyncError): void {
  slot.save(err)
}

export function clearSyncError(): void {
  slot.save(null)
}
