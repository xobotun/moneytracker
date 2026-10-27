import type { SyncTable } from './syncTables'
import type { SyncRow } from './types'
import { changedSince } from './rows'
import { rowHash, type RowHashes } from './syncBase'

/**
 * Tells the merge whether a row changed on its side since this device last
 * agreed with the remote. The merge asks it about both copies of a row that
 * differ, and takes the side that changed.
 */
export interface ChangeDetector {
  changed(table: SyncTable, row: SyncRow): Promise<boolean>
  /**
   * True when "neither side changed" is certain: two copies that still differ
   * then differ only in what the detector leaves out, and are not a conflict.
   */
  readonly exact: boolean
}

/**
 * The fallback when there is no usable base: a row changed when one of its
 * timestamps is later than `cutoff`, the upload time of this device's last
 * sync. It misses a change made offline and uploaded after another device's
 * sync (docs/plans/2026-10-26-sync-change-detection.md).
 */
export function cutoffDetector(cutoff: string): ChangeDetector {
  return {
    exact: false,
    changed: (_table, row) => Promise.resolve(changedSince(row, cutoff)),
  }
}

/**
 * A row changed when its hash differs from its hash in `base`, whatever its
 * timestamps say. A row the base lacks is new since then, so it changed.
 */
export function baseDetector(base: RowHashes): ChangeDetector {
  return {
    exact: true,
    changed: async (table, row) =>
      (await rowHash(table, row)) !== base.get(table.name)?.get(String(row[table.pk])),
  }
}
