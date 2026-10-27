import { Database, type SqlExecutor } from '../../db/Database'
import type { TagKind } from '../../db/types'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'

/** A fresh in-memory database with all migrations applied. */
export async function newMigratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

export interface SeedTagInput {
  id: string
  name: string
  created: string
  updated: string
  /** When the parent was last set. Default `updated`: the last change was a move. */
  moved?: string
  deleted?: string | null
  /** Default `location`. */
  kind?: TagKind
  parentId?: string | null
  mergedIntoId?: string | null
}

/** Inserts one tag (by default a top-level `location`) with explicit timestamps. */
export async function seedTag(db: SqlExecutor, input: SeedTagInput): Promise<void> {
  await db.run(
    `INSERT INTO tags (id, kind, name, parent_id, moved_at_utc, merged_into_id,
                       created_at_utc, updated_at_utc, deleted_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.kind ?? 'location',
      input.name,
      input.parentId ?? null,
      input.moved ?? input.updated,
      input.mergedIntoId ?? null,
      input.created,
      input.updated,
      input.deleted ?? null,
    ],
  )
}

export interface SeedAccountInput {
  id: string
  name: string
  created: string
  updated: string
  locationId?: string | null
  /** Plain-tag ids, stored as the `tags` JSON array. */
  tags?: string[]
}

/** Inserts one row into `accounts` with a zero balance and explicit timestamps. */
export async function seedAccount(db: SqlExecutor, input: SeedAccountInput): Promise<void> {
  await db.run(
    `INSERT INTO accounts
       (id, name, currency, balance_value, balance_scale, tags, location_id, colour, icon,
        created_at_utc, updated_at_utc)
     VALUES (?, ?, 'USD', 0, 2, ?, ?, '#000000', 'wallet', ?, ?)`,
    [
      input.id,
      input.name,
      JSON.stringify(input.tags ?? []),
      input.locationId ?? null,
      input.created,
      input.updated,
    ],
  )
}

export interface SeedTransactionInput {
  id: string
  accountFrom: string
  created: string
  updated: string
  /** Plain-tag ids, stored as the `tags` JSON array. */
  tags?: string[]
  merchantId?: string | null
}

/** Inserts one minimal row into `transactions` referencing `accountFrom`. */
export async function seedTransaction(db: SqlExecutor, input: SeedTransactionInput): Promise<void> {
  await db.run(
    `INSERT INTO transactions
       (id, account_id__from, account_id__to,
        amount_value__from, amount_scale__from, amount_currency__from,
        amount_value__to, amount_scale__to, amount_currency__to,
        transaction_at_local, transaction_at_zone, tags, merchant_id,
        created_at_utc, updated_at_utc)
     VALUES (?, ?, NULL, 100, 2, 'USD', 100, 2, 'USD',
             '2026-05-01T09:00:00.000+00:00', 'UTC', ?, ?, ?, ?)`,
    [
      input.id,
      input.accountFrom,
      JSON.stringify(input.tags ?? []),
      input.merchantId ?? null,
      input.created,
      input.updated,
    ],
  )
}

/**
 * Bulk-inserts `count` live top-level `location` tags in one statement. Ids
 * are zero-padded hex counters (1-based), so primary-key order equals n;
 * `descriptionFor(n)` may set a description.
 */
export async function seedTags(
  db: Database,
  count: number,
  descriptionFor: (n: number) => string | null = () => null,
): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: (i + 1).toString(16).padStart(12, '0'),
    name: `Loc ${i + 1}`,
    description: descriptionFor(i + 1),
  }))
  await db.run(
    `INSERT INTO tags (id, kind, name, description, synonyms,
                       moved_at_utc, created_at_utc, updated_at_utc)
     SELECT json_extract(value, '$.id'), 'location', json_extract(value, '$.name'),
            json_extract(value, '$.description'), '[]',
            '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
     FROM json_each(?)`,
    [JSON.stringify(rows)],
  )
}
