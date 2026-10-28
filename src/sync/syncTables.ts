/** A domain table the merge engine reconciles, plus its primary key column. */
export interface SyncTable {
  name: string
  pk: string
}

/**
 * Domain tables to merge, ordered parents-before-children so that applying
 * upserts in this order never violates a foreign key between tables
 * (algorithm step 6):
 *   - the side tables (`*_details`) reference tags
 *   - accounts reference tags (location) and account_groupings
 *   - transactions reference accounts and tags (location)
 * `tags` also references itself (parent_id, merged_into_id), which no table
 * order can settle: `mergeDatabases` and `importAllTables` check foreign keys
 * at COMMIT. `applied_rates` has no foreign keys and sits with the other
 * parent-free tables. `images` has none either; it comes first, as icons in
 * tags, accounts and groups refer to it (by JSON, not by a foreign key).
 *
 * The `settings` and `migrations` tables are intentionally absent: settings are
 * device-local-ish and ride along inside the uploaded blob without row merge;
 * migrations are reconciled by the schema gate, not by row merge. Nor is
 * `exchange_rates`, the device-local rate library: it can always be downloaded
 * again (it still rides along inside an uploaded blob, never merged).
 * `sync_base` and `sync_base_info` (the per-row hashes of the last agreed
 * state, see syncBase.ts) are device-local in the same way.
 */
export const SYNC_TABLES: readonly SyncTable[] = [
  { name: 'images', pk: 'id' },
  { name: 'tags', pk: 'id' },
  { name: 'location_details', pk: 'tag_id' },
  { name: 'merchant_details', pk: 'tag_id' },
  { name: 'journey_details', pk: 'tag_id' },
  { name: 'applied_rates', pk: 'id' },
  { name: 'account_groupings', pk: 'id' },
  { name: 'accounts', pk: 'id' },
  { name: 'transactions', pk: 'id' },
]
