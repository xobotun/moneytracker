// Shared type definitions for the database sync module.
// See docs/scenarios/2026-05-22-database-sync-scenarios.md.

/** A raw database row: column name → value, exactly as `SELECT *` returns it. */
export type SyncRow = Record<string, unknown>

/** Metadata stored alongside the remote database blob. */
export interface SyncMetadata {
  /** Device name of the device that produced this upload. Stable identity
   *  for the sync algorithm; carries through to other devices as the value
   *  shown in their Settings "Uploaded by" rows. */
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
  /** Device name (matches `SyncMetadata.device` of the recorded upload). */
  device: string
  uploadedAtUtc: string
  hash: string
}

/**
 * How a row-level conflict was resolved. `loop-undone`: the merge combined two
 * changes into a parent loop or a merge cycle of tags, and the later change
 * was undone. `delete-undone`: the merge left a live transaction on a deleted
 * category, and the category's delete was undone (see `repairTags`).
 */
export type ConflictResolution =
  | 'delete-wins'
  | 'rank-wins'
  | 'latest-update-wins'
  | 'loop-undone'
  | 'delete-undone'

/**
 * A row that was modified on both sides since the merge cutoff, or a tag
 * whose change the post-merge repair undid. `local` / `remote` are the row as
 * each side had it before the merge — an empty object when a side lacked it
 * (only a repair can involve such a row). `winner` is the side whose version
 * was kept; for `loop-undone` and `delete-undone`, the side whose parent or
 * liveness the tag went back to.
 */
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
