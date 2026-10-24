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

export interface ColumnDescriptor {
  name: string
  sqlType: 'TEXT' | 'INTEGER' | 'REAL'
  nullable: boolean
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

  exchange_rates: [
    { name: 'id', sqlType: 'TEXT', nullable: true },
    { name: 'date', sqlType: 'TEXT', nullable: false },
    { name: 'base_currency', sqlType: 'TEXT', nullable: false },
    { name: 'rates', sqlType: 'TEXT', nullable: false },
    { name: 'provider', sqlType: 'TEXT', nullable: false },
    { name: 'created_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'updated_at_utc', sqlType: 'TEXT', nullable: false },
    { name: 'deleted_at_utc', sqlType: 'TEXT', nullable: true },
  ],

  account_groupings: [
    { name: 'id', sqlType: 'TEXT', nullable: true },
    { name: 'name', sqlType: 'TEXT', nullable: false },
    { name: 'colour', sqlType: 'TEXT', nullable: false },
    { name: 'icon', sqlType: 'TEXT', nullable: false },
    { name: 'accounts_ids', sqlType: 'TEXT', nullable: false },
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
