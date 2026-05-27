/** A domain table the merge engine reconciles, plus its primary key column. */
export interface SyncTable {
  name: string
  pk: string
}

/**
 * Domain tables to merge, ordered parents-before-children so that applying
 * upserts in this order never violates a foreign key (algorithm step 6):
 *   - accounts reference locations
 *   - transactions reference accounts and locations
 * `exchange_rates` and `account_groupings` have no foreign keys, so they sit
 * in the first tier with the other parent-free tables.
 *
 * The `settings` and `migrations` tables are intentionally absent: settings are
 * device-local-ish and ride along inside the uploaded blob without row merge;
 * migrations are reconciled by the schema gate, not by row merge.
 *
 * NOTE: `account_groupings` is currently covered only by the SYNC_TABLES
 * presence assertion below. It has no FK to other tables and behaves like any
 * other top-tier domain table, so the generic mergeTable tests are
 * representative — but a dedicated test using its `accounts_ids` JSON column
 * is worth adding once the table has real seed helpers.
 */
export const SYNC_TABLES: readonly SyncTable[] = [
  { name: 'locations', pk: 'id' },
  { name: 'tags', pk: 'tag' },
  { name: 'exchange_rates', pk: 'id' },
  { name: 'account_groupings', pk: 'id' },
  { name: 'accounts', pk: 'id' },
  { name: 'transactions', pk: 'id' },
]
