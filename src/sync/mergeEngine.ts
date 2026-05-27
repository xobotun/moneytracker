import type { Database } from '../db/Database'
import type { SyncConflict, SyncRow } from './types'
import type { SyncTable } from './syncTables'
import { changedSince, readRows, rowsEqual, upsertRow } from './rows'
import { resolveConflict } from './resolveConflict'
import { SYNC_TABLES } from './syncTables'

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
  local: Database,
  remote: Database,
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
    if (rowsEqual(localRow, remoteRow)) continue

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
    const { winner, resolution } = resolveConflict(localRow, remoteRow)
    if (winner === 'remote') {
      await upsertRow(local, table.name, table.pk, remoteRow)
    }
    conflicts.push({ table: table.name, primaryKey: key, local: localRow, remote: remoteRow, winner, resolution })
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
  const conflicts: SyncConflict[] = []
  await local.run('BEGIN')
  try {
    for (const table of SYNC_TABLES) {
      const tableConflicts = await mergeTable(local, remote, table, cutoff)
      conflicts.push(...tableConflicts)
    }
    await local.run('COMMIT')
  } catch (e) {
    await local.run('ROLLBACK')
    throw e
  }
  return conflicts
}
