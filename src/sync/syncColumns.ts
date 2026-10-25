// Per-table column type descriptors used by csvCodec's bulk-import path.
//
// For each table in SYNC_TABLES, lists the columns in CREATE-TABLE order
// with their SQLite affinity and nullability. The CSV import builds a
// SELECT list from this descriptor:
//
//   INTEGER     → CAST(json_extract(value, '$.col') AS INTEGER)
//   REAL        → CAST(json_extract(value, '$.col') AS REAL)
//   TEXT + null → nullif(json_extract(value, '$.col'), '')
//   TEXT + !null→ json_extract(value, '$.col')
//
// The match against PRAGMA table_info is enforced by syncColumns.spec.ts —
// changing the schema and forgetting to update this file fails CI.

import type { SyncRow } from './types'

export interface ColumnDescriptor {
  name: string
  sqlType: 'TEXT' | 'INTEGER' | 'REAL'
  nullable: boolean
}

/**
 * Columns that cache something computed from other rows on each device (the
 * account balance, from the transactions). The merge and the database hash
 * ignore them — two devices may hold different values mid-flight, and that
 * must not count as a conflict or a difference — and the merge rebuilds them
 * afterwards (`recalculateBalances`). They still travel in the CSV / blob,
 * possibly stale, which is safe: any reader merges, and the merge overwrites
 * whatever value arrived.
 */
export const DERIVED_COLUMNS: Record<string, readonly string[]> = {
  accounts: ['balance_value', 'balance_scale'],
}

/**
 * Columns the merge comparison and the database hash skip: the derived ones,
 * plus the timestamps of rows each device computes on its own. Two devices
 * that resolve the same applied rate write the same row at different moments;
 * that is neither a conflict nor a difference. A real change still counts —
 * the merge reads the timestamps to see which side moved.
 */
export const EQUALITY_IGNORED_COLUMNS: Record<string, readonly string[]> = {
  ...DERIVED_COLUMNS,
  applied_rates: ['created_at_utc', 'updated_at_utc'],
}

/**
 * How firmly a row holds in a sync conflict, for tables where some rows must
 * win whatever the timestamps. After "delete wins", the higher rank wins;
 * equal ranks fall back to the newest. Applied rates: the user's override (3)
 * over a direct rate (2) over a cross (1) over none found (0), so an override
 * is never lost to a device that resolved the same day, and a found rate never
 * to an empty row from a device that was offline.
 */
export const ROW_RANK: Record<string, (row: SyncRow) => number> = {
  applied_rates: (row) =>
    row.provider === 'manual' ? 3 : row.rate === null ? 0 : row.via === null ? 2 : 1,
}

export const SYNC_COLUMNS: Record<string, ColumnDescriptor[]> = {
  locations: [
    { name: 'id', sqlType: 'TEXT', nullable: true },
    { name: 'name', sqlType: 'TEXT', nullable: false },
    { name: 'description', sqlType: 'TEXT', nullable: true },
    { name: 'address', sqlType: 'TEXT', nullable: true },
    { name: 'city', sqlType: 'TEXT', nullable: true },
    { name: 'country', sqlType: 'TEXT', nullable: true },
    { name: 'latitude', sqlType: 'REAL', nullable: true },
    { name: 'longitude', sqlType: 'REAL', nullable: true },
    { name: 'tags', sqlType: 'TEXT', nullable: false },
    { name: 'created_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'updated_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'deleted_at_utc', sqlType: 'TEXT', nullable: true },
  ],

  tags: [
    { name: 'tag', sqlType: 'TEXT', nullable: true },
    { name: 'description', sqlType: 'TEXT', nullable: true },
    { name: 'synonyms', sqlType: 'TEXT', nullable: false },
    { name: 'colour', sqlType: 'TEXT', nullable: false },
    { name: 'icon', sqlType: 'TEXT', nullable: false },
    { name: 'created_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'updated_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'deleted_at_utc', sqlType: 'TEXT', nullable: true },
  ],

  applied_rates: [
    { name: 'id', sqlType: 'TEXT', nullable: true },
    { name: 'date', sqlType: 'TEXT', nullable: false },
    { name: 'currency_a', sqlType: 'TEXT', nullable: false },
    { name: 'currency_b', sqlType: 'TEXT', nullable: false },
    { name: 'rate', sqlType: 'REAL', nullable: true },
    { name: 'provider', sqlType: 'TEXT', nullable: true },
    { name: 'via', sqlType: 'TEXT', nullable: true },
    { name: 'reference_date', sqlType: 'TEXT', nullable: true },
    { name: 'created_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'updated_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'deleted_at_utc', sqlType: 'TEXT', nullable: true },
  ],

  account_groupings: [
    { name: 'id', sqlType: 'TEXT', nullable: true },
    { name: 'name', sqlType: 'TEXT', nullable: false },
    { name: 'colour', sqlType: 'TEXT', nullable: false },
    { name: 'icon', sqlType: 'TEXT', nullable: false },
    { name: 'sort_order', sqlType: 'INTEGER', nullable: false },
    { name: 'created_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'updated_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'deleted_at_utc', sqlType: 'TEXT', nullable: true },
  ],

  accounts: [
    { name: 'id', sqlType: 'TEXT', nullable: true },
    { name: 'name', sqlType: 'TEXT', nullable: false },
    { name: 'currency', sqlType: 'TEXT', nullable: false },
    { name: 'balance_value', sqlType: 'INTEGER', nullable: false },
    { name: 'balance_scale', sqlType: 'INTEGER', nullable: false },
    { name: 'tags', sqlType: 'TEXT', nullable: false },
    { name: 'location_id', sqlType: 'TEXT', nullable: true },
    { name: 'colour', sqlType: 'TEXT', nullable: false },
    { name: 'icon', sqlType: 'TEXT', nullable: false },
    { name: 'grouping_id', sqlType: 'TEXT', nullable: true },
    { name: 'sort_order', sqlType: 'INTEGER', nullable: false },
    { name: 'created_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'updated_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'deleted_at_utc', sqlType: 'TEXT', nullable: true },
  ],

  transactions: [
    { name: 'id', sqlType: 'TEXT', nullable: true },
    { name: 'account_id__from', sqlType: 'TEXT', nullable: true },
    { name: 'account_id__to', sqlType: 'TEXT', nullable: true },
    { name: 'amount_value__from', sqlType: 'INTEGER', nullable: false },
    { name: 'amount_scale__from', sqlType: 'INTEGER', nullable: false },
    { name: 'amount_currency__from', sqlType: 'TEXT', nullable: false },
    { name: 'amount_value__to', sqlType: 'INTEGER', nullable: false },
    { name: 'amount_scale__to', sqlType: 'INTEGER', nullable: false },
    { name: 'amount_currency__to', sqlType: 'TEXT', nullable: false },
    { name: 'transaction_at_local', sqlType: 'TEXT', nullable: false },
    { name: 'transaction_at_zone', sqlType: 'TEXT', nullable: false },
    { name: 'date_override_local', sqlType: 'TEXT', nullable: true },
    { name: 'date_override_zone', sqlType: 'TEXT', nullable: true },
    { name: 'tags', sqlType: 'TEXT', nullable: false },
    { name: 'location_lat', sqlType: 'REAL', nullable: true },
    { name: 'location_lon', sqlType: 'REAL', nullable: true },
    { name: 'location_id', sqlType: 'TEXT', nullable: true },
    { name: 'created_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'updated_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'deleted_at_utc', sqlType: 'TEXT', nullable: true },
  ],
}
