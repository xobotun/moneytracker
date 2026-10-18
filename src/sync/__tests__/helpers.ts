import { Database } from '../../db/Database'
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

export interface SeedLocationInput {
  id: string
  name: string
  created: string
  updated: string
  deleted?: string | null
}

/** Inserts one row into `locations` with explicit timestamps. */
export async function seedLocation(db: Database, input: SeedLocationInput): Promise<void> {
  await db.run(
    `INSERT INTO locations (id, name, created_at_utc, updated_at_utc, deleted_at_utc)
     VALUES (?, ?, ?, ?, ?)`,
    [input.id, input.name, input.created, input.updated, input.deleted ?? null],
  )
}

export interface SeedAccountInput {
  id: string
  name: string
  created: string
  updated: string
  locationId?: string | null
}

/** Inserts one row into `accounts` with a zero balance and explicit timestamps. */
export async function seedAccount(db: Database, input: SeedAccountInput): Promise<void> {
  await db.run(
    `INSERT INTO accounts
       (id, name, currency, balance_value, balance_scale, location_id, colour, icon,
        created_at_utc, updated_at_utc)
     VALUES (?, ?, 'USD', 0, 2, ?, '#000000', 'wallet', ?, ?)`,
    [input.id, input.name, input.locationId ?? null, input.created, input.updated],
  )
}

export interface SeedTransactionInput {
  id: string
  accountFrom: string
  created: string
  updated: string
}

/** Inserts one minimal row into `transactions` referencing `accountFrom`. */
export async function seedTransaction(db: Database, input: SeedTransactionInput): Promise<void> {
  await db.run(
    `INSERT INTO transactions
       (id, account_id__from, account_id__to,
        amount_value__from, amount_scale__from, amount_currency__from,
        amount_value__to, amount_scale__to, amount_currency__to,
        transaction_at_local, transaction_at_zone,
        created_at_utc, updated_at_utc)
     VALUES (?, ?, NULL, 100, 2, 'USD', 100, 2, 'USD',
             '2026-05-01T09:00:00.000+00:00', 'UTC', ?, ?)`,
    [input.id, input.accountFrom, input.created, input.updated],
  )
}

/**
 * Bulk-inserts `count` live locations in one statement. Ids are
 * zero-padded hex counters (1-based), so primary-key order equals n;
 * `descriptionFor(n)` may set a description.
 */
export async function seedLocations(
  db: Database,
  count: number,
  descriptionFor: (n: number) => string | null = () => null,
): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: (i + 1).toString(16).padStart(32, '0'),
    name: `Loc ${i + 1}`,
    description: descriptionFor(i + 1),
  }))
  await db.run(
    `INSERT INTO locations (id, name, description, tags, created_at_utc, updated_at_utc)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.name'),
            json_extract(value, '$.description'), '[]',
            '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
     FROM json_each(?)`,
    [JSON.stringify(rows)],
  )
}
