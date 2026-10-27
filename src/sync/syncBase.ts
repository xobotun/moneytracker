import type { Database, SqlExecutor } from '../db/Database'
import { SYNC_TABLES, type SyncTable } from './syncTables'
import { canonicalLine, hashLines } from './hashDatabase'
import type { SyncRow } from './types'

// The sync base: a short hash of every synced row as it stood when this device
// last agreed with its remote. A row whose current hash equals its base hash
// has not changed here since, whatever its timestamps say. Stored in the
// device-local `sync_base` / `sync_base_info` tables (migration 003).

/** Table name → primary key → `rowHash`. */
export type RowHashes = Map<string, Map<string, string>>

/** The rows of a database as hashes, with the hash `hashDatabase` gives the same rows. */
export interface Snapshot {
  databaseHash: string
  rows: RowHashes
}

/** What a base was agreed with. */
export interface BaseSource {
  /** `SyncBackend.remoteId` of the remote. */
  remoteId: string
  /** Migration version the rows were hashed at. */
  schemaVersion: number
}

export interface SyncBaseInfo extends BaseSource {
  /** `hashDatabase` of the rows the base holds. */
  databaseHash: string
}

/**
 * Lower-case hex of the first 16 bytes of SHA-256 over the row's line.
 *
 * A live row hashes as the line `hashDatabase` uses. A deleted one hashes as
 * its identity and delete time only: a tombstone changes by being deleted or
 * restored, and the stamp-less rewrites of its references (a tag merge, the
 * sync repair's redirect) must not count as a change, or they would hide a
 * concurrent restore.
 */
export async function rowHash(table: SyncTable, row: SyncRow): Promise<string> {
  const line =
    row.deleted_at_utc == null
      ? canonicalLine(table, row)
      : `${table.name} ${JSON.stringify([row[table.pk], row.deleted_at_utc])}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(line))
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

/** Every synced row of a database at one moment, with the hash `hashDatabase` gives them. */
export interface SyncedRows {
  databaseHash: string
  /** Each of `SYNC_TABLES` in order, with its rows sorted by primary key. */
  tables: { table: SyncTable; rows: SyncRow[] }[]
}

/**
 * Reads every synced row and hashes them as `hashDatabase` does. The rows are
 * read in one transaction, so they are a consistent state even if the app
 * writes meanwhile. Their own hashes come from `hashRows`, separately: an
 * upload needs only the database hash before it starts.
 */
export async function readSyncedRows(db: Database): Promise<SyncedRows> {
  const tables = await db.transaction(async (tx) => {
    const read: SyncedRows['tables'] = []
    for (const table of SYNC_TABLES) {
      const rows = await tx.exec<SyncRow>(`SELECT * FROM ${table.name} ORDER BY ${table.pk}`)
      read.push({ table, rows })
    }
    return read
  })
  const lines = tables.flatMap(({ table, rows }) => rows.map((row) => canonicalLine(table, row)))
  return { databaseHash: await hashLines(lines), tables }
}

/** The snapshot of rows `readSyncedRows` read: their `rowHash`es. */
export async function hashRows(read: SyncedRows): Promise<Snapshot> {
  const rows: RowHashes = new Map()
  for (const { table, rows: tableRows } of read.tables) {
    const hashes = new Map<string, string>()
    for (const row of tableRows) hashes.set(String(row[table.pk]), await rowHash(table, row))
    rows.set(table.name, hashes)
  }
  return { databaseHash: read.databaseHash, rows }
}

/** Reads and hashes every synced row at once: `readSyncedRows`, then `hashRows`. */
export async function snapshotDatabase(db: Database): Promise<Snapshot> {
  return hashRows(await readSyncedRows(db))
}

/** The base's description; null when this device has no base. */
export async function readSyncBaseInfo(db: SqlExecutor): Promise<SyncBaseInfo | null> {
  const [info] = await db.exec<{
    remote_id: string
    database_hash: string
    schema_version: number
  }>('SELECT remote_id, database_hash, schema_version FROM sync_base_info')
  if (!info) return null
  return {
    remoteId: info.remote_id,
    databaseHash: info.database_hash,
    schemaVersion: info.schema_version,
  }
}

/** The base's row hashes; empty when this device has no base. */
export async function readSyncBase(db: SqlExecutor): Promise<RowHashes> {
  const stored = await db.exec<{ table_name: string; pk: string; row_hash: string }>(
    'SELECT table_name, pk, row_hash FROM sync_base',
  )
  const rows: RowHashes = new Map()
  for (const { table_name, pk, row_hash } of stored) {
    let hashes = rows.get(table_name)
    if (!hashes) rows.set(table_name, (hashes = new Map()))
    hashes.set(pk, row_hash)
  }
  return rows
}

/**
 * Replaces the whole base and its description. The caller provides the
 * transaction, so the base commits (or rolls back) with whatever it belongs to.
 */
export async function writeSyncBase(
  tx: SqlExecutor,
  snapshot: Snapshot,
  source: BaseSource,
): Promise<void> {
  await tx.run('DELETE FROM sync_base')
  await tx.run('DELETE FROM sync_base_info')

  // One JSON array of [table, pk, hash] — `json_each` reads it as rows, so the
  // whole base goes in with a single statement.
  const triples: [string, string, string][] = []
  for (const [table, hashes] of snapshot.rows) {
    for (const [pk, hash] of hashes) triples.push([table, pk, hash])
  }
  await tx.run(
    `INSERT INTO sync_base (table_name, pk, row_hash)
     SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
     FROM json_each(?)`,
    [JSON.stringify(triples)],
  )
  await tx.run(
    `INSERT INTO sync_base_info (id, remote_id, database_hash, schema_version)
     VALUES (1, ?, ?, ?)`,
    [source.remoteId, snapshot.databaseHash, source.schemaVersion],
  )
}
