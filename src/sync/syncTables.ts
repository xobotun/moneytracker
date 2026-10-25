/** A domain table the merge engine reconciles, plus its primary key column. */
export interface SyncTable {
  name: string
  pk: string
}

/**
 * Domain tables to merge, ordered parents-before-children so that applying
 * upserts in this order never violates a foreign key (algorithm step 6):
 *   - accounts reference locations and account_groupings
 *   - transactions reference accounts and locations
 * `applied_rates` has no foreign keys and sits in the first tier with the
 * other parent-free tables.
 *
 * The `settings` and `migrations` tables are intentionally absent: settings are
 * device-local-ish and ride along inside the uploaded blob without row merge;
 * migrations are reconciled by the schema gate, not by row merge. Nor is
 * `exchange_rates`, the device-local rate library: it can always be downloaded
 * again (it still rides along inside an uploaded blob, never merged).
 */
export const SYNC_TABLES: readonly SyncTable[] = [
  { name: 'locations', pk: 'id' },
  { name: 'tags', pk: 'tag' },
  { name: 'applied_rates', pk: 'id' },
  { name: 'account_groupings', pk: 'id' },
  { name: 'accounts', pk: 'id' },
  { name: 'transactions', pk: 'id' },
]
