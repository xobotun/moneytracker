import type { Database, SqlExecutor } from '../db/Database'
import type { SyncConflict, SyncRow } from './types'
import type { SyncTable } from './syncTables'
import { changedSince, readRows, rowsEqual, upsertRow } from './rows'
import { resolveConflict } from './resolveConflict'
import { SYNC_TABLES } from './syncTables'
import { EQUALITY_IGNORED_COLUMNS, ROW_RANK } from './syncColumns'
import { recalculateBalances } from '../db/balances'

/** Index a list of rows by the value of their primary key column. */
function indexByPk(rows: SyncRow[], pk: string): Map<string, SyncRow> {
  // Every PK column in SYNC_TABLES is declared TEXT (UUIDv7 or `tags.tag`),
  // so the value is already a string — no coercion needed.
  const map = new Map<string, SyncRow>()
  for (const row of rows) {
    map.set(row[pk] as string, row)
  }
  return map
}

/**
 * Reconcile one table from `remote` into `local`. Applies remote-winning rows
 * to `local` via upsert and returns the conflicts encountered. The caller is
 * responsible for wrapping the writes in a transaction (see `mergeDatabases`).
 *
 * `cutoff` is the last successful sync timestamp; a row counts as "changed"
 * only if it was created/updated/deleted after it.
 */
export async function mergeTable(
  local: SqlExecutor,
  remote: SqlExecutor,
  table: SyncTable,
  cutoff: string,
): Promise<SyncConflict[]> {
  const localRows = indexByPk(await readRows(local, table.name), table.pk)
  const remoteRows = indexByPk(await readRows(remote, table.name), table.pk)
  const conflicts: SyncConflict[] = []

  for (const [key, remoteRow] of remoteRows) {
    const localRow = localRows.get(key)

    // Remote-only row → this device has not seen it yet, insert it.
    if (!localRow) {
      await upsertRow(local, table.name, table.pk, remoteRow)
      continue
    }

    // Same row on both sides → nothing to do.
    if (rowsEqual(localRow, remoteRow, EQUALITY_IGNORED_COLUMNS[table.name])) continue

    const localChanged = changedSince(localRow, cutoff)
    const remoteChanged = changedSince(remoteRow, cutoff)

    // Only the remote moved → take the remote version.
    if (remoteChanged && !localChanged) {
      await upsertRow(local, table.name, table.pk, remoteRow)
      continue
    }

    // Only the local moved → keep the local version.
    if (localChanged && !remoteChanged) continue

    // Both moved (or neither did but the rows differ) → conflict.
    const { winner, resolution } = resolveConflict(localRow, remoteRow, ROW_RANK[table.name])
    if (winner === 'remote') {
      await upsertRow(local, table.name, table.pk, remoteRow)
    }
    conflicts.push({
      table: table.name,
      primaryKey: key,
      local: localRow,
      remote: remoteRow,
      winner,
      resolution,
    })
  }

  // Local-only rows need no action — they stay in `local` and are uploaded as-is.
  return conflicts
}

/**
 * Reconcile every domain table from `remote` into `local` (algorithm steps
 * 6–7). Tables are merged parents-before-children so foreign keys hold, and
 * all writes run inside one transaction so a crash or failure cannot leave a
 * half-merged database.
 */
export async function mergeDatabases(
  local: Database,
  remote: Database,
  cutoff: string,
): Promise<SyncConflict[]> {
  // `transaction` holds the local connection's lock for the whole merge, so an
  // app write made meanwhile waits instead of landing inside (and being rolled
  // back with) a failed merge, and cannot change rows between read and upsert.
  return local.transaction(async (tx) => {
    const conflicts: SyncConflict[] = []
    for (const table of SYNC_TABLES) {
      conflicts.push(...(await mergeTable(tx, remote, table, cutoff)))
    }
    // The derived columns were not merged: rebuild them from the merged rows,
    // so every device ends up with the same values (and the same hash).
    await recalculateBalances(tx)
    return conflicts
  })
}
