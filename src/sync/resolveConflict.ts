import type { ConflictResolution, SyncRow } from './types'
import { effectiveTimestamp, isDeleted } from './rows'

export interface ConflictResult {
  winner: 'local' | 'remote'
  resolution: ConflictResolution
}

/**
 * Resolve a row changed on both sides since the two sides last agreed (the
 * base, or the cutoff when there is none), or two copies that differ though
 * neither side changed them (see "Conflict resolution" in the sync scenarios
 * doc):
 *  1. If exactly one side deleted the row, the delete wins — keep the tombstone.
 *  2. Given the table's `rank` (see ROW_RANK), the higher-ranked side wins.
 *  3. Otherwise the side with the latest updated/deleted timestamp wins.
 *  4. An exact tie goes to the row whose content sorts greater (`canonicalRow`,
 *     without the `ignore` columns); identical rows go to local.
 *
 * Rule 4 must not favour either side: each device sees its own copy as local,
 * and a tie left to "local" would have both keep their own copy forever (a
 * sync repair keeps the timestamp of a row it rewrites, so its copy and the
 * other device's can tie). Comparing the content picks the same copy on both.
 */
export function resolveConflict(
  local: SyncRow,
  remote: SyncRow,
  rank?: (row: SyncRow) => number,
  ignore: readonly string[] = [],
): ConflictResult {
  const localDeleted = isDeleted(local)
  const remoteDeleted = isDeleted(remote)

  if (localDeleted && !remoteDeleted) return { winner: 'local', resolution: 'delete-wins' }
  if (remoteDeleted && !localDeleted) return { winner: 'remote', resolution: 'delete-wins' }

  if (rank) {
    const localRank = rank(local)
    const remoteRank = rank(remote)
    if (localRank !== remoteRank) {
      return { winner: localRank > remoteRank ? 'local' : 'remote', resolution: 'rank-wins' }
    }
  }

  const localAt = effectiveTimestamp(local)
  const remoteAt = effectiveTimestamp(remote)
  if (localAt !== remoteAt) {
    return { winner: localAt > remoteAt ? 'local' : 'remote', resolution: 'latest-update-wins' }
  }
  const winner = canonicalRow(local, ignore) >= canonicalRow(remote, ignore) ? 'local' : 'remote'
  return { winner, resolution: 'latest-update-wins' }
}

/**
 * The row as text that reads the same on every device: its columns sorted by
 * name, without `ignore`, each value JSON-encoded (a BLOB as its bytes).
 */
function canonicalRow(row: SyncRow, ignore: readonly string[]): string {
  return JSON.stringify(
    Object.keys(row)
      .filter((column) => !ignore.includes(column))
      .sort()
      .map((column) => {
        const value = row[column]
        return [column, value instanceof Uint8Array ? Array.from(value) : value]
      }),
  )
}
