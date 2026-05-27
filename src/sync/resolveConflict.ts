import type { ConflictResolution, SyncRow } from './types'
import { effectiveTimestamp, isDeleted } from './rows'

export interface ConflictResult {
  winner: 'local' | 'remote'
  resolution: ConflictResolution
}

/**
 * Resolve a row modified on both sides since the merge cutoff
 * (see "Conflict resolution" in the sync scenarios doc):
 *  1. If exactly one side deleted the row, the delete wins — keep the tombstone.
 *  2. Otherwise the side with the latest updated/deleted timestamp wins.
 *  3. An exact tie goes to local, so the result is deterministic.
 */
export function resolveConflict(local: SyncRow, remote: SyncRow): ConflictResult {
  const localDeleted = isDeleted(local)
  const remoteDeleted = isDeleted(remote)

  if (localDeleted && !remoteDeleted) return { winner: 'local', resolution: 'delete-wins' }
  if (remoteDeleted && !localDeleted) return { winner: 'remote', resolution: 'delete-wins' }

  const winner = effectiveTimestamp(local) >= effectiveTimestamp(remote) ? 'local' : 'remote'
  return { winner, resolution: 'latest-update-wins' }
}
