// Shared type definitions for the database sync module.
// See docs/scenarios/2026-05-22-database-sync-scenarios.md.

/** A raw database row: column name → value, exactly as `SELECT *` returns it. */
export type SyncRow = Record<string, unknown>

/** Metadata stored alongside the remote database blob. */
export interface SyncMetadata {
  /** Device id of the device that produced this upload. */
  device: string
  /** When the upload happened — ISO 8601 UTC. */
  uploadedAtUtc: string
  /** Hash of the uploaded database blob. */
  hash: string
  /** Schema (migration) version of the uploaded database. */
  migrationVersion: number
}

/** What a device recorded locally at its last successful sync. */
export interface RemoteState {
  device: string
  uploadedAtUtc: string
  hash: string
}

/** How a row-level conflict was resolved. */
export type ConflictResolution = 'delete-wins' | 'latest-update-wins'

/** A row that was modified on both sides since the merge cutoff. */
export interface SyncConflict {
  table: string
  primaryKey: string
  local: SyncRow
  remote: SyncRow
  winner: 'local' | 'remote'
  resolution: ConflictResolution
}

/** Outcome of a sync run, surfaced to the caller (UI lands in the follow-up plan). */
export type SyncOutcomeDecision =
  | 'none' // scenario 1 — databases identical
  | 'first-sync-upload' // remote was empty
  | 'upload-local' // scenario 2.1 — this device was the last uploader
  | 'merge' // scenario 2.2 — merged a foreign upload
  | 'aborted-app-outdated' // remote schema newer than this app

export interface SyncOutcome {
  decision: SyncOutcomeDecision
  conflicts: SyncConflict[]
  uploaded: boolean
}

/** Lower bound used as the merge cutoff when no prior sync watermark exists. */
export const EPOCH_UTC = '1970-01-01T00:00:00.000Z'
