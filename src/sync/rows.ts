import type { SqlExecutor } from '../db/Database'
import type { SyncRow } from './types'

/** Reads every row of `table` as raw column maps. */
export async function readRows(db: SqlExecutor, table: string): Promise<SyncRow[]> {
  // `table` always comes from the SYNC_TABLES constant, never user input.
  return db.exec<SyncRow>(`SELECT * FROM ${table}`)
}

/**
 * Strict equality, with byte-by-byte comparison for Uint8Array (BLOB) values.
 * SQLite has five storage classes (NULL, INTEGER, REAL, TEXT, BLOB) and
 * wa-sqlite maps the first four to JS primitives — strict `===` works for
 * them. BLOBs come back as Uint8Array, where every read creates a fresh
 * instance, so `===` would always be false; compare bytes instead.
 */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
  }
  return false
}

/** True when two rows have identical values for every column. */
export function rowsEqual(a: SyncRow, b: SyncRow): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (!valueEquals(a[key], b[key])) return false
  }
  return true
}

/** True when the row carries a soft-delete tombstone. */
export function isDeleted(row: SyncRow): boolean {
  return row.deleted_at_utc != null
}

/**
 * The timestamp that decides recency for a row: its delete time if deleted,
 * otherwise its last update time. Both are ISO 8601 UTC strings.
 */
export function effectiveTimestamp(row: SyncRow): string {
  return (row.deleted_at_utc as string | null) ?? (row.updated_at_utc as string)
}

/** True when the row was created, updated, or deleted after `cutoff`. */
export function changedSince(row: SyncRow, cutoff: string): boolean {
  const created = row.created_at_utc as string
  const updated = row.updated_at_utc as string
  const deleted = row.deleted_at_utc as string | null
  return created > cutoff || updated > cutoff || (deleted != null && deleted > cutoff)
}

/**
 * Inserts `row` into `table`, or overwrites the existing row with the same
 * primary key. Uses SQLite UPSERT (`ON CONFLICT DO UPDATE`) rather than
 * `INSERT OR REPLACE`: REPLACE deletes the old row first, which would trip
 * `ON DELETE RESTRICT` foreign keys when the row is referenced.
 */
export async function upsertRow(
  db: SqlExecutor,
  table: string,
  pk: string,
  row: SyncRow,
): Promise<void> {
  const cols = Object.keys(row)
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols
    .filter((c) => c !== pk)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  await db.run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(${pk}) DO UPDATE SET ${updates}`,
    cols.map((c) => row[c]),
  )
}
