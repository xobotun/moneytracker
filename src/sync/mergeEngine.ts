import type { Database, SqlExecutor } from '../db/Database'
import type { SyncConflict, SyncRow } from './types'
import type { SyncTable } from './syncTables'
import type { ChangeDetector } from './changeDetection'
import { readRows, rowsEqual, upsertRow } from './rows'
import { resolveConflict } from './resolveConflict'
import { SYNC_TABLES } from './syncTables'
import { EQUALITY_IGNORED_COLUMNS, ROW_RANK } from './syncColumns'
import { snapshotDatabase, writeSyncBase, type BaseSource } from './syncBase'
import { recalculateBalances } from '../db/balances'
import { repairTags } from './repairTags'

/** Index a list of rows by the value of their primary key column. */
function indexByPk(rows: SyncRow[], pk: string): Map<string, SyncRow> {
  // Every PK column in SYNC_TABLES is declared TEXT (UUIDs or short ids),
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
 * `changes` tells which side changed a row since this device last agreed with
 * the remote (by base hashes, or by the last sync's cutoff). It is asked only
 * about rows whose two copies differ.
 */
export async function mergeTable(
  local: SqlExecutor,
  remote: SqlExecutor,
  table: SyncTable,
  changes: ChangeDetector,
): Promise<SyncConflict[]> {
  const localRows = indexByPk(await readRows(local, table.name), table.pk)
  const remoteRows = indexByPk(await readRows(remote, table.name), table.pk)
  const conflicts: SyncConflict[] = []
  const ignored = EQUALITY_IGNORED_COLUMNS[table.name] ?? []

  for (const [key, remoteRow] of remoteRows) {
    const localRow = localRows.get(key)

    // Remote-only row → this device has not seen it yet, insert it.
    if (!localRow) {
      await upsertRow(local, table.name, table.pk, remoteRow)
      continue
    }

    // Same row on both sides → nothing to do.
    if (rowsEqual(localRow, remoteRow, ignored)) continue

    const localChanged = await changes.changed(table, localRow)
    const remoteChanged = await changes.changed(table, remoteRow)

    // Only the remote moved → take the remote version.
    if (remoteChanged && !localChanged) {
      await upsertRow(local, table.name, table.pk, remoteRow)
      continue
    }

    // Only the local moved → keep the local version.
    if (localChanged && !remoteChanged) continue

    // Both moved since the two sides last agreed (the base, or the cutoff
    // when there is none) → conflict. Neither moved but the rows differ →
    // settled the same way; reported only when the detector is not exact.
    const { winner, resolution } = resolveConflict(
      localRow,
      remoteRow,
      ROW_RANK[table.name],
      ignored,
    )
    if (winner === 'remote') {
      await upsertRow(local, table.name, table.pk, remoteRow)
    }
    // Neither moved, for certain (base hashes): two tombstones that differ only
    // in what their hash leaves out, such as references a tag merge rewrote
    // without a stamp. No change is lost: settle them the same way on every
    // device, without a report.
    if (!localChanged && !remoteChanged && changes.exact) continue
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
 * 6–7), then repair the tags (`repairTags`; its `loop-undone` and
 * `delete-undone` conflicts are returned with the merge's). Tables are merged
 * parents-before-children, and
 * all writes run inside one transaction so a crash or failure cannot leave a
 * half-merged database. Foreign keys are checked when it commits.
 *
 * With a `source`, the remote's rows become the new sync base in the same
 * transaction: the downloaded database is what the merged one and anything
 * uploaded after it have in common, and a failed merge leaves the old base.
 */
export async function mergeDatabases(
  local: Database,
  remote: Database,
  changes: ChangeDetector,
  source?: BaseSource,
): Promise<SyncConflict[]> {
  // Hashing the remote needs no local lock: do it before the transaction,
  // which holds back every app query while it runs. Without a source there is
  // no await here, so the merge still queues ahead of an app write issued
  // after this call.
  const base = source ? await snapshotDatabase(remote) : null
  // `transaction` holds the local connection's lock for the whole merge, so an
  // app write made meanwhile waits instead of landing inside (and being rolled
  // back with) a failed merge, and cannot change rows between read and upsert.
  return local.transaction(async (tx) => {
    // A child tag can come before its parent (no table order settles the
    // tags' references to each other): check foreign keys at COMMIT only.
    await tx.run('PRAGMA defer_foreign_keys = ON')
    // What each side had, so the repair can undo a change to the other side's version.
    const tagsBefore = {
      local: indexByPk(await readRows(tx, 'tags'), 'id'),
      remote: indexByPk(await readRows(remote, 'tags'), 'id'),
    }
    const conflicts: SyncConflict[] = []
    for (const table of SYNC_TABLES) {
      conflicts.push(...(await mergeTable(tx, remote, table, changes)))
    }
    // Merging row by row can combine changes into states no device produced:
    // references to merged tags, orphaned children, parent loops, merge cycles.
    conflicts.push(...(await repairTags(tx, tagsBefore)))
    // The derived columns were not merged: rebuild them from the merged rows,
    // so every device ends up with the same values (and the same hash).
    await recalculateBalances(tx)
    if (source && base) await writeSyncBase(tx, base, source)
    return conflicts
  })
}
