# Domain Schema Implementation Plan

Status: **DONE**

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the full domain schema (accounts, transactions, exchange_rates, tags, locations, account_groupings) on top of the existing wa-sqlite persistence layer, plus a typed repository per entity. The schema is sync-friendly from day one and ready for the Phase 2 timestamp-merge sync described in the persistence-layer design.

**Architecture:** One combined migration (`002_domain_schema.ts`) creates all six tables with hard foreign keys. Six new repositories mirror the existing `SettingsRepository` pattern (constructor takes a `Database`; methods stamp timestamps explicitly, no triggers). No Pinia stores, no UI, no sync — those land in follow-up plans.

**Out of scope (deferred):**
- Pinia stores wrapping these repositories.
- Supabase sync (file hash + last-modified metadata mentioned in the original draft).
- Exchange-rate fetcher (openexchangerates / fawazahmed0). The table is created; population is a later plan.
- Any UI.

---

## Conventions used in this schema

These extend the CLAUDE.md conventions. Where this plan introduces new conventions, they're marked **(new)**.

### Naming

- **Primary keys** are `id TEXT PRIMARY KEY` holding a UUIDv7 generated client-side. Exception: `tags.tag` is a natural string key (a tag *is* its name).
- **Single underscore** separates words within a column name, including when one logical value is split into two related columns (e.g., `transaction_at_local` + `transaction_at_zone`, `latitude` + `longitude`).
- **Double underscore** **(new)** separates a column's base name from a *discriminator suffix*, used only when several columns belong to one logical grouping that needs distinguishing. The from/to legs of double-entry transactions are the only place this applies in this schema:
  - `account_id__from` / `account_id__to`
  - `amount_value__from` / `amount_value__to`
  - `amount_scale__from` / `amount_scale__to`
  - `amount_currency__from` / `amount_currency__to`

  Rule of thumb: if removing the suffix would name a real concept and there are 2+ parallel suffixed variants, use `__`. Otherwise use `_`.

### Timestamps

There are two semantically distinct kinds of time in this schema, with different suffixes:

- **`_utc` suffix** — TEXT, ISO 8601 with `Z` (e.g., `2026-03-15T14:30:00.000Z`). A pure UTC **instant** — "when did this row get written". Used for `created_at_utc`, `updated_at_utc`, `deleted_at_utc`.
- **`_local` + `_zone` suffix pair** **(new)** — TEXT, offset-bearing ISO 8601 (e.g., `2013-10-07T04:23:19.120+04:00`) plus IANA zone name (e.g., `Europe/Berlin`). A **civil moment anchored to a place** — "I bought coffee at 9am Berlin local time". Both fields are needed because:
  - The offset alone (`+04:00`) doesn't identify the zone — `+02:00` matches Berlin in summer, Cairo in winter, Athens in winter. The IANA zone lets us correctly redo "what day of week" / DST-aware queries later.
  - The offset-bearing string preserves the exact wall-clock the user saw, even if they later move zones.

Used for `transaction_at_local`/`transaction_at_zone` and `date_override_local`/`date_override_zone`.

### Money — BigDecimal triples

Every monetary amount is stored as three columns: `<name>_value INTEGER`, `<name>_scale INTEGER`, `<name>_currency TEXT`. This mirrors Java's `BigDecimal(unscaledValue, scale)` plus a currency tag, and:

- Avoids floating-point drift.
- Works natively for crypto (e.g., BTC `(1, 8)` = 0.00000001 BTC) without a separate currencies table.
- Self-describes precision per row — a forex spread can record more decimals than display.

Currency code is an opaque TEXT (3+ chars), usually ISO 4217 (`USD`, `EUR`) but allowed to be anything (`BTC`, `USDT`). Formatting on the frontend uses [accounting.js](https://openexchangerates.github.io/accounting.js/).

### Soft delete + sync columns

Every domain table has the same three columns: `created_at_utc`, `updated_at_utc`, `deleted_at_utc`. Repositories filter `deleted_at_utc IS NOT NULL` out of `find`/`list` queries by default. This is the foundation for the Phase 2 timestamp-merge sync from `2026-03-15-persistence-layer-design.md` — without `deleted_at_utc`, a row deleted on device A would resurrect when device B syncs back its older copy.

### Foreign keys

All cross-table references are declared as `FOREIGN KEY ... REFERENCES ... ON DELETE RESTRICT`. `PRAGMA foreign_keys = ON` is set in `Database.init()` (SQLite has FK support off by default). Soft-deletes are still allowed because `deleted_at_utc` doesn't trigger FK checks; only a true `DELETE FROM` would, and that's what we want to catch.

### JSON columns

`tags` (arrays of strings), `synonyms` (arrays of strings), `accounts_ids` (array of UUIDs), and `exchange_rates.rates` (string→number map) are declared `TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(<col>))`. The CHECK constraint uses SQLite's JSON1 module to reject malformed writes at insert time. Queries that need to look inside use `json_each(...)` / `json_extract(...)`.

### SQLite type affinity sanity check

SQLite has only five affinities (NULL, INTEGER, REAL, TEXT, BLOB) and assigns them by keyword-matching the declared type string. Anything we write like `UUID`, `JSON`, `DECIMAL`, `TIMESTAMPTZ` is just a label — it doesn't mean what it does in PostgreSQL. Audit of every column kind in this schema:

| Field kind | Declared type | Affinity | Note |
|---|---|---|---|
| UUIDv7 PK / FK | `TEXT` | TEXT | Declaring `UUID` would resolve to **BLOB** (no affinity keyword in the string) — silent footgun. Always declare as `TEXT`. |
| `*_utc` timestamps | `TEXT` | TEXT | ISO 8601 with `Z`. Lexicographic order = chronological order. |
| `*_local` timestamps | `TEXT` | TEXT | Offset-bearing ISO 8601. Paired with `*_zone` TEXT (IANA name). |
| `*_value` (BigDecimal) | `INTEGER` | INTEGER | 8-byte signed (~9.2e18). Ample for any currency at realistic scales. |
| `*_scale` (BigDecimal) | `INTEGER` | INTEGER | Small int (0–18). |
| `*_currency` | `TEXT` | TEXT | ISO 4217 or custom (`BTC`). |
| latitude / longitude | `REAL` | REAL | 8-byte float, ~15 sig digits — 1e-7 ≈ 11 mm. Storing as TEXT would lose ordering. |
| Colour | `TEXT` | TEXT | `#RRGGBB`. |
| Icon / name / description / address | `TEXT` | TEXT | Plain strings. |
| JSON columns (`tags`, `synonyms`, `accounts_ids`, `rates`) | `TEXT` | TEXT | Plus `CHECK (json_valid(col))`. |
| Booleans (none in this schema yet) | `INTEGER` | INTEGER | When needed later: declare INTEGER, store 0/1. Declaring `BOOLEAN` resolves to NUMERIC affinity and silently coerces. |

---

## Final schema

```sql
-- 1. Locations (no FK deps — declared first)
CREATE TABLE locations (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  address         TEXT,
  city            TEXT,
  country         TEXT,
  latitude        REAL,
  longitude       REAL,
  tags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  deleted_at_utc  TEXT
);

-- 2. Tags
CREATE TABLE tags (
  tag             TEXT PRIMARY KEY,           -- natural key
  description     TEXT,
  synonyms        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(synonyms)),
  colour          TEXT NOT NULL,
  icon            TEXT NOT NULL,
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  deleted_at_utc  TEXT
);

-- 3. Accounts
CREATE TABLE accounts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  currency        TEXT NOT NULL,
  balance_value   INTEGER NOT NULL,
  balance_scale   INTEGER NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  location_id     TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  colour          TEXT NOT NULL,
  icon            TEXT NOT NULL,
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  deleted_at_utc  TEXT
);

-- 4. Exchange rates (historical cache)
CREATE TABLE exchange_rates (
  id              TEXT PRIMARY KEY,
  date            TEXT NOT NULL,              -- 'YYYY-MM-DD'
  base_currency   TEXT NOT NULL,              -- e.g. 'USD'
  rates           TEXT NOT NULL CHECK (json_valid(rates)),
  provider        TEXT NOT NULL,              -- e.g. 'openexchangerates', 'fawazahmed0'
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  deleted_at_utc  TEXT
);
CREATE INDEX idx_exchange_rates_lookup ON exchange_rates(date, base_currency);
-- No UNIQUE(date, base_currency): multiple providers may have rates for the same day.

-- 5. Account groupings
CREATE TABLE account_groupings (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  colour          TEXT NOT NULL,
  icon            TEXT NOT NULL,
  accounts_ids    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(accounts_ids)),
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  deleted_at_utc  TEXT
);

-- 6. Transactions (double-entry bookkeeping)
CREATE TABLE transactions (
  id                       TEXT PRIMARY KEY,                                  -- UUIDv7
  account_id__from         TEXT REFERENCES accounts(id) ON DELETE RESTRICT,   -- NULL = income from Global Economy
  account_id__to           TEXT REFERENCES accounts(id) ON DELETE RESTRICT,   -- NULL = spend into Global Economy
  amount_value__from       INTEGER NOT NULL,
  amount_scale__from       INTEGER NOT NULL,
  amount_currency__from    TEXT NOT NULL,
  amount_value__to         INTEGER NOT NULL,
  amount_scale__to         INTEGER NOT NULL,
  amount_currency__to      TEXT NOT NULL,
  transaction_at_local     TEXT NOT NULL,    -- e.g. '2013-10-07T04:23:19.120+04:00'
  transaction_at_zone      TEXT NOT NULL,    -- e.g. 'Europe/Berlin'
  date_override_local      TEXT,             -- e.g. ticket bought in Nov for Feb event
  date_override_zone       TEXT,
  tags                     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  location_lat             REAL,
  location_lon             REAL,
  location_id              TEXT REFERENCES locations(id) ON DELETE RESTRICT,  -- takes priority over lat/lon
  created_at_utc           TEXT NOT NULL,
  updated_at_utc           TEXT NOT NULL,
  deleted_at_utc           TEXT
);
CREATE INDEX idx_transactions_account_from ON transactions(account_id__from)     WHERE deleted_at_utc IS NULL;
CREATE INDEX idx_transactions_account_to   ON transactions(account_id__to)       WHERE deleted_at_utc IS NULL;
CREATE INDEX idx_transactions_at_local     ON transactions(transaction_at_local) WHERE deleted_at_utc IS NULL;
```

Notes on the transaction shape worth keeping in mind during implementation:

- For income from "Global Economy": `account_id__from IS NULL`, `account_id__to` set. The `amount_*__from` triple still has values — they represent the abstract source amount (e.g., a tax refund of "100 EUR" coming in). Currency on both sides is required.
- For spending into "Global Economy": `account_id__to IS NULL`, `account_id__from` set. Same — `amount_*__to` still recorded so we know "this purchase was 12.50 EUR even though it left a USD account".
- For transfers between own accounts: both `account_id__*` set; `amount_*__from` and `amount_*__to` may differ in value if exchange happened at a custom rate.
- `location_id` (when set) takes priority over `location_lat`/`location_lon` for display/aggregation. The lat/lon fields are a fallback when there's no matching `locations` row yet.

---

## Tasks

### Task 1: Install `uuid` package and add UUIDv7 helper

**Files:**
- Modify: `package.json`
- Create: `src/db/uuid.ts`
- Create: `src/db/__tests__/uuid.spec.ts`

**Step 1: Install**

Run: `npm install uuid`
Run: `npm install --save-dev @types/uuid`

**Step 2: Write the test**

```typescript
// src/db/__tests__/uuid.spec.ts
import { describe, it, expect } from 'vitest'
import { newId } from '../uuid'

describe('newId', () => {
  it('returns a 36-character UUID string', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('produces lexicographically sortable ids over time', async () => {
    const a = newId()
    await new Promise((r) => setTimeout(r, 5))
    const b = newId()
    expect(a < b).toBe(true)
  })

  it('returns unique ids on rapid calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()))
    expect(ids.size).toBe(1000)
  })
})
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/uuid.spec.ts`
Expected: FAIL — `../uuid` module not found.

**Step 4: Implement**

```typescript
// src/db/uuid.ts
import { v7 } from 'uuid'

/** Generate a UUIDv7. Time-ordered, suitable as a primary key that also sorts chronologically. */
export function newId(): string {
  return v7()
}
```

A thin wrapper exists so tests can mock id generation via `vi.mock('@/db/uuid', ...)` when they need deterministic ids.

**Step 5: Run tests**

Run: `npx vitest run src/db/__tests__/uuid.spec.ts`
Expected: All 3 tests PASS.

**Step 6: Commit**

```
feat: add UUIDv7 helper for primary keys
```

---

### Task 2: Enable foreign key enforcement in `Database.init()`

**Files:**
- Modify: `src/db/Database.ts`
- Modify: `src/db/__tests__/Database.spec.ts`

**Step 1: Add a failing test**

```typescript
// Add to src/db/__tests__/Database.spec.ts
it('has foreign_keys pragma enabled', async () => {
  db = new Database()
  await db.init()
  const rows = await db.exec<{ foreign_keys: number }>('PRAGMA foreign_keys')
  expect(rows[0]!.foreign_keys).toBe(1)
})

it('enforces foreign key constraints', async () => {
  db = new Database()
  await db.init()
  await db.run('CREATE TABLE parent (id TEXT PRIMARY KEY)')
  await db.run('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))')
  await expect(
    db.run('INSERT INTO child (id, parent_id) VALUES (?, ?)', ['c1', 'missing'])
  ).rejects.toThrow()
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/Database.spec.ts`
Expected: New tests FAIL — default `PRAGMA foreign_keys` is 0.

**Step 3: Update `Database.init()`**

Right after `open_v2` succeeds and before returning, run:

```typescript
await this.run('PRAGMA foreign_keys = ON')
```

(Use the class's own `run()` since the connection is open and `ensureOpen()` will pass.)

**Step 4: Run tests**

Run: `npx vitest run src/db/`
Expected: All previous tests still PASS; the two new ones PASS.

**Step 5: Commit**

```
feat: enable foreign_keys pragma on Database.init()
```

---

### Task 3: Write the domain schema migration

**Files:**
- Create: `src/db/migrations/002_domain_schema.ts`
- Modify: `src/db/init.ts` — register the new migration
- Create: `src/db/__tests__/domainSchema.spec.ts`

**Step 1: Write the test**

```typescript
// src/db/__tests__/domainSchema.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../Database'
import { runMigrations } from '../migrations'
import { migration as settingsMigration } from '../migrations/001_settings'
import { migration as domainMigration } from '../migrations/002_domain_schema'

const EXPECTED_TABLES = [
  'accounts',
  'transactions',
  'exchange_rates',
  'tags',
  'locations',
  'account_groupings',
]

describe('domain schema migration', () => {
  let db: Database

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates all six domain tables', async () => {
    const rows = await db.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN " +
        `(${EXPECTED_TABLES.map(() => '?').join(',')}) ORDER BY name`,
      EXPECTED_TABLES
    )
    expect(rows.map((r) => r.name).sort()).toEqual([...EXPECTED_TABLES].sort())
  })

  it('rejects malformed JSON in tags column (json_valid CHECK)', async () => {
    await expect(
      db.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?)`,
        ['loc1', 'X', 'not json', '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
      )
    ).rejects.toThrow()
  })

  it('enforces FK from accounts.location_id to locations.id', async () => {
    await expect(
      db.run(
        `INSERT INTO accounts (id, name, currency, balance_value, balance_scale,
                               location_id, colour, icon, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['a1', 'Acc', 'USD', 0, 2, 'missing-loc', '#FFFFFF', 'cash',
         '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
      )
    ).rejects.toThrow()
  })

  it('enforces FK from transactions.account_id__from to accounts.id', async () => {
    await expect(
      db.run(
        `INSERT INTO transactions (id, account_id__from, account_id__to,
                                   amount_value__from, amount_scale__from, amount_currency__from,
                                   amount_value__to, amount_scale__to, amount_currency__to,
                                   transaction_at_local, transaction_at_zone,
                                   created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['t1', 'missing-acc', null, 100, 2, 'USD', 100, 2, 'USD',
         '2026-05-20T12:00:00.000+02:00', 'Europe/Berlin',
         '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
      )
    ).rejects.toThrow()
  })

  it('allows account_id__from / account_id__to to be NULL (Global Economy)', async () => {
    // First create an account to receive
    await db.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale,
                             colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['a1', 'Acc', 'USD', 0, 2, '#FFFFFF', 'cash',
       '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
    )
    await db.run(
      `INSERT INTO transactions (id, account_id__from, account_id__to,
                                 amount_value__from, amount_scale__from, amount_currency__from,
                                 amount_value__to, amount_scale__to, amount_currency__to,
                                 transaction_at_local, transaction_at_zone,
                                 created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['t1', null, 'a1', 100, 2, 'USD', 100, 2, 'USD',
       '2026-05-20T12:00:00.000+02:00', 'Europe/Berlin',
       '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']
    )
    const rows = await db.exec('SELECT id FROM transactions')
    expect(rows).toHaveLength(1)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/domainSchema.spec.ts`
Expected: FAIL — `../migrations/002_domain_schema` module not found.

**Step 3: Implement the migration**

```typescript
// src/db/migrations/002_domain_schema.ts
import type { Migration } from './index'

export const migration: Migration = {
  version: 2,
  up: `
    CREATE TABLE locations (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT,
      address         TEXT,
      city            TEXT,
      country         TEXT,
      latitude        REAL,
      longitude       REAL,
      tags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );

    CREATE TABLE tags (
      tag             TEXT PRIMARY KEY,
      description     TEXT,
      synonyms        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(synonyms)),
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL,
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );

    CREATE TABLE accounts (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      currency        TEXT NOT NULL,
      balance_value   INTEGER NOT NULL,
      balance_scale   INTEGER NOT NULL,
      tags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
      location_id     TEXT REFERENCES locations(id) ON DELETE RESTRICT,
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL,
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );

    CREATE TABLE exchange_rates (
      id              TEXT PRIMARY KEY,
      date            TEXT NOT NULL,
      base_currency   TEXT NOT NULL,
      rates           TEXT NOT NULL CHECK (json_valid(rates)),
      provider        TEXT NOT NULL,
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );
    CREATE INDEX idx_exchange_rates_lookup ON exchange_rates(date, base_currency);

    CREATE TABLE account_groupings (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL,
      accounts_ids    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(accounts_ids)),
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );

    CREATE TABLE transactions (
      id                       TEXT PRIMARY KEY,
      account_id__from         TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
      account_id__to           TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
      amount_value__from       INTEGER NOT NULL,
      amount_scale__from       INTEGER NOT NULL,
      amount_currency__from    TEXT NOT NULL,
      amount_value__to         INTEGER NOT NULL,
      amount_scale__to         INTEGER NOT NULL,
      amount_currency__to      TEXT NOT NULL,
      transaction_at_local     TEXT NOT NULL,
      transaction_at_zone      TEXT NOT NULL,
      date_override_local      TEXT,
      date_override_zone       TEXT,
      tags                     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
      location_lat             REAL,
      location_lon             REAL,
      location_id              TEXT REFERENCES locations(id) ON DELETE RESTRICT,
      created_at_utc           TEXT NOT NULL,
      updated_at_utc           TEXT NOT NULL,
      deleted_at_utc           TEXT
    );
    CREATE INDEX idx_transactions_account_from ON transactions(account_id__from)     WHERE deleted_at_utc IS NULL;
    CREATE INDEX idx_transactions_account_to   ON transactions(account_id__to)       WHERE deleted_at_utc IS NULL;
    CREATE INDEX idx_transactions_at_local     ON transactions(transaction_at_local) WHERE deleted_at_utc IS NULL;
  `,
}
```

> **Note on multi-statement migrations:** the `Database.run()` implementation uses `sqlite3.statements()` which iterates over all statements in the SQL string, so this single `up` blob will execute every CREATE in order. Verify this with the test above before relying on it. If `run()` only executes the first statement, update the migration runner (or `Database.run()`) to step every statement returned by the iterator.

**Step 4: Register the migration in `src/db/init.ts`**

```typescript
// In src/db/init.ts
import { migration as domainMigration } from './migrations/002_domain_schema'

const allMigrations = [settingsMigration, domainMigration]
```

**Step 5: Run tests**

Run: `npx vitest run src/db/__tests__/domainSchema.spec.ts`
Expected: All 5 tests PASS.

Also run the full `src/db/` suite to confirm nothing regressed:

Run: `npx vitest run src/db/`
Expected: All tests PASS.

**Step 6: Commit**

```
feat: add domain schema migration (accounts, transactions, etc.)
```

---

### Task 4: Define the `MoneyAmount` value type

**Files:**
- Create: `src/db/MoneyAmount.ts`
- Create: `src/db/__tests__/MoneyAmount.spec.ts`

A first-class value type for the BigDecimal-style triplet (unscaled integer + scale + currency code). Lives in its own file so it can be imported cleanly anywhere money is handled — repositories, future Pinia stores, future formatting helpers.

**Step 1: Write the test**

```typescript
// src/db/__tests__/MoneyAmount.spec.ts
import { describe, it, expect } from 'vitest'
import { MoneyAmount, moneyAmount, zeroMoney } from '../MoneyAmount'

describe('MoneyAmount', () => {
  it('factory returns a frozen object with the three fields', () => {
    const m: MoneyAmount = moneyAmount(1234, 2, 'USD')
    expect(m).toEqual({ value: 1234, scale: 2, currency: 'USD' })
    expect(Object.isFrozen(m)).toBe(true)
  })

  it('zeroMoney returns a zero-value amount in the given currency', () => {
    expect(zeroMoney('EUR', 2)).toEqual({ value: 0, scale: 2, currency: 'EUR' })
  })

  it('rejects non-integer value', () => {
    expect(() => moneyAmount(1.5, 2, 'USD')).toThrow()
  })

  it('rejects negative scale', () => {
    expect(() => moneyAmount(100, -1, 'USD')).toThrow()
  })

  it('rejects empty currency code', () => {
    expect(() => moneyAmount(100, 2, '')).toThrow()
  })

  it('accepts crypto-scale amounts (BTC with scale=8)', () => {
    const m = moneyAmount(1, 8, 'BTC')
    expect(m.value).toBe(1)
    expect(m.scale).toBe(8)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/MoneyAmount.spec.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

```typescript
// src/db/MoneyAmount.ts

/**
 * A BigDecimal-style monetary amount.
 *
 * `value` is the unscaled integer (e.g., 1234), `scale` is the number of decimal
 * places (e.g., 2 → 12.34), `currency` is an opaque code (ISO 4217 like 'USD' or
 * custom like 'BTC'). Mirrors Java's `BigDecimal(unscaledValue, scale)` + a tag.
 */
export interface MoneyAmount {
  readonly value: number
  readonly scale: number
  readonly currency: string
}

export function moneyAmount(value: number, scale: number, currency: string): MoneyAmount {
  if (!Number.isInteger(value)) throw new Error(`MoneyAmount value must be an integer, got ${value}`)
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`MoneyAmount scale must be a non-negative integer, got ${scale}`)
  if (!currency || currency.trim().length === 0) throw new Error('MoneyAmount currency must be a non-empty string')
  return Object.freeze({ value, scale, currency })
}

export function zeroMoney(currency: string, scale = 2): MoneyAmount {
  return moneyAmount(0, scale, currency)
}
```

> **Deliberately out of scope here:** arithmetic (`add`, `subtract`, `convert`), parsing from user input ("12.34" → MoneyAmount), and display formatting. Those live in follow-up modules once we have a real use case — likely on top of accounting.js.

**Step 4: Run tests**

Run: `npx vitest run src/db/__tests__/MoneyAmount.spec.ts`
Expected: All tests PASS.

**Step 5: Commit**

```
feat: add MoneyAmount value type
```

---

### Task 5: Column mappers (MoneyAmount, LocalMoment, JSON) + `LocalMoment` type

**Files:**
- Create: `src/db/LocalMoment.ts`
- Create: `src/db/__tests__/LocalMoment.spec.ts`
- Create: `src/db/columnMappers.ts`
- Create: `src/db/__tests__/columnMappers.spec.ts`

Every repository will need to convert between rich JS objects (`MoneyAmount`, `LocalMoment`, arrays/objects from JSON columns) and the flat column shape SQLite stores. Centralising this in one module avoids drift across six repositories and gives one place to test edge cases.

**Types/values requiring mappers in this schema:**

| Domain type | Column shape | Used in |
|---|---|---|
| `MoneyAmount` | `<prefix>_value INTEGER` + `<prefix>_scale INTEGER` + `<prefix>_currency TEXT` | accounts (`balance_*`), transactions (`amount_*__from`, `amount_*__to`) |
| `LocalMoment` | `<prefix>_local TEXT` + `<prefix>_zone TEXT` (both nullable together) | transactions (`transaction_at_*`, `date_override_*`) |
| `string[]` (tags / synonyms / accounts_ids) | single TEXT column holding a JSON array | locations, tags, accounts, transactions, account_groupings |
| `Record<string, number>` (exchange rates map) | single TEXT column holding a JSON object | exchange_rates |

UUIDs, plain timestamps (`*_utc`), colours, icons, latitude/longitude are passed through unchanged — they need no mapper.

**Step 1: Implement `LocalMoment`**

```typescript
// src/db/LocalMoment.ts

/**
 * A civil moment anchored to an IANA zone.
 *
 * `local` is an offset-bearing ISO 8601 string (e.g. '2013-10-07T04:23:19.120+04:00')
 * that preserves the exact wall-clock the user saw plus the offset they were at.
 * `zone` is the IANA zone name (e.g. 'Europe/Berlin') — needed because the offset
 * alone doesn't identify the zone (DST, multi-zone offsets).
 */
export interface LocalMoment {
  readonly local: string
  readonly zone: string
}

export function localMoment(local: string, zone: string): LocalMoment {
  if (!local) throw new Error('LocalMoment local string must be non-empty')
  if (!zone) throw new Error('LocalMoment zone must be non-empty')
  return Object.freeze({ local, zone })
}
```

**Step 2: Write the LocalMoment test**

```typescript
// src/db/__tests__/LocalMoment.spec.ts
import { describe, it, expect } from 'vitest'
import { localMoment } from '../LocalMoment'

describe('LocalMoment', () => {
  it('constructs a frozen { local, zone } pair', () => {
    const m = localMoment('2013-10-07T04:23:19.120+04:00', 'Europe/Berlin')
    expect(m.local).toBe('2013-10-07T04:23:19.120+04:00')
    expect(m.zone).toBe('Europe/Berlin')
    expect(Object.isFrozen(m)).toBe(true)
  })

  it('rejects empty local string', () => {
    expect(() => localMoment('', 'UTC')).toThrow()
  })

  it('rejects empty zone', () => {
    expect(() => localMoment('2013-10-07T04:23:19.120Z', '')).toThrow()
  })
})
```

Run: `npx vitest run src/db/__tests__/LocalMoment.spec.ts` — Expected: PASS.

**Step 3: Write the column-mapper test**

```typescript
// src/db/__tests__/columnMappers.spec.ts
import { describe, it, expect } from 'vitest'
import { moneyAmount } from '../MoneyAmount'
import { localMoment } from '../LocalMoment'
import {
  moneyToColumns,
  moneyFromRow,
  localMomentToColumns,
  localMomentFromRow,
  jsonArrayToColumn,
  jsonArrayFromColumn,
  jsonObjectToColumn,
  jsonObjectFromColumn,
} from '../columnMappers'

describe('moneyToColumns / moneyFromRow', () => {
  it('flattens a MoneyAmount into prefixed columns', () => {
    expect(moneyToColumns('balance', moneyAmount(1234, 2, 'USD'))).toEqual({
      balance_value: 1234,
      balance_scale: 2,
      balance_currency: 'USD',
    })
  })

  it('reads back a MoneyAmount from a row', () => {
    const row = { balance_value: 1234, balance_scale: 2, balance_currency: 'USD', other: 'ignored' }
    expect(moneyFromRow('balance', row)).toEqual(moneyAmount(1234, 2, 'USD'))
  })

  it('round-trips a discriminated prefix (amount__from)', () => {
    const m = moneyAmount(50000000, 8, 'BTC')
    const cols = moneyToColumns('amount__from', m)
    expect(cols).toEqual({
      'amount_value__from': 50000000,
      'amount_scale__from': 8,
      'amount_currency__from': 'BTC',
    })
    expect(moneyFromRow('amount__from', cols)).toEqual(m)
  })
})

describe('localMomentToColumns / localMomentFromRow', () => {
  it('flattens and reads back a LocalMoment', () => {
    const lm = localMoment('2013-10-07T04:23:19.120+04:00', 'Europe/Berlin')
    const cols = localMomentToColumns('transaction_at', lm)
    expect(cols).toEqual({
      transaction_at_local: '2013-10-07T04:23:19.120+04:00',
      transaction_at_zone: 'Europe/Berlin',
    })
    expect(localMomentFromRow('transaction_at', cols)).toEqual(lm)
  })

  it('returns null from a row when both columns are null (nullable LocalMoment)', () => {
    expect(localMomentFromRow('date_override', { date_override_local: null, date_override_zone: null })).toBeNull()
  })

  it('throws if only one of local/zone is null (corrupt row)', () => {
    expect(() => localMomentFromRow('date_override', { date_override_local: 'x', date_override_zone: null })).toThrow()
  })

  it('flattens null LocalMoment to two nulls', () => {
    expect(localMomentToColumns('date_override', null)).toEqual({
      date_override_local: null,
      date_override_zone: null,
    })
  })
})

describe('jsonArrayToColumn / jsonArrayFromColumn', () => {
  it('stringifies a string array', () => {
    expect(jsonArrayToColumn(['a', 'b'])).toBe('["a","b"]')
  })

  it('stringifies an empty array', () => {
    expect(jsonArrayToColumn([])).toBe('[]')
  })

  it('parses back a string array', () => {
    expect(jsonArrayFromColumn('["a","b"]')).toEqual(['a', 'b'])
  })

  it('throws on malformed JSON (should have been caught by CHECK json_valid)', () => {
    expect(() => jsonArrayFromColumn('not json')).toThrow()
  })

  it('throws if the parsed value is not an array', () => {
    expect(() => jsonArrayFromColumn('{"a":1}')).toThrow()
  })
})

describe('jsonObjectToColumn / jsonObjectFromColumn', () => {
  it('round-trips an exchange-rates map', () => {
    const rates = { AED: 3.67, EUR: 0.92 }
    expect(jsonObjectFromColumn<number>(jsonObjectToColumn(rates))).toEqual(rates)
  })

  it('throws if the parsed value is not an object', () => {
    expect(() => jsonObjectFromColumn('[1,2,3]')).toThrow()
  })
})
```

**Step 4: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/columnMappers.spec.ts`
Expected: FAIL — module not found.

**Step 5: Implement the mappers**

```typescript
// src/db/columnMappers.ts
import { type MoneyAmount, moneyAmount } from './MoneyAmount'
import { type LocalMoment, localMoment } from './LocalMoment'

// ---------- MoneyAmount ↔ three columns ----------

export function moneyToColumns(
  prefix: string,
  m: MoneyAmount,
): Record<string, number | string> {
  const { base, suffix } = splitDiscriminator(prefix)
  return {
    [`${base}_value${suffix}`]: m.value,
    [`${base}_scale${suffix}`]: m.scale,
    [`${base}_currency${suffix}`]: m.currency,
  }
}

export function moneyFromRow(prefix: string, row: Record<string, unknown>): MoneyAmount {
  const { base, suffix } = splitDiscriminator(prefix)
  return moneyAmount(
    row[`${base}_value${suffix}`] as number,
    row[`${base}_scale${suffix}`] as number,
    row[`${base}_currency${suffix}`] as string,
  )
}

// ---------- LocalMoment ↔ two columns (nullable as a pair) ----------

export function localMomentToColumns(
  prefix: string,
  lm: LocalMoment | null,
): Record<string, string | null> {
  return {
    [`${prefix}_local`]: lm?.local ?? null,
    [`${prefix}_zone`]: lm?.zone ?? null,
  }
}

export function localMomentFromRow(prefix: string, row: Record<string, unknown>): LocalMoment | null {
  const local = row[`${prefix}_local`] as string | null
  const zone = row[`${prefix}_zone`] as string | null
  if (local === null && zone === null) return null
  if (local === null || zone === null) {
    throw new Error(`Inconsistent LocalMoment in column ${prefix}_local/${prefix}_zone — one is null, the other is not`)
  }
  return localMoment(local, zone)
}

// ---------- JSON array column ----------

export function jsonArrayToColumn<T>(arr: T[]): string {
  return JSON.stringify(arr)
}

export function jsonArrayFromColumn<T>(text: string): T[] {
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array')
  return parsed as T[]
}

// ---------- JSON object column ----------

export function jsonObjectToColumn<V>(obj: Record<string, V>): string {
  return JSON.stringify(obj)
}

export function jsonObjectFromColumn<V>(text: string): Record<string, V> {
  const parsed = JSON.parse(text) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object')
  }
  return parsed as Record<string, V>
}

// ---------- helpers ----------

/**
 * Split a prefix into a base and an optional `__discriminator` suffix.
 *
 * Examples:
 *   'balance'         → { base: 'balance',  suffix: '' }
 *   'amount__from'    → { base: 'amount',   suffix: '__from' }
 *   'amount__to'      → { base: 'amount',   suffix: '__to' }
 *
 * Lets `moneyToColumns('amount__from', m)` produce `amount_value__from`,
 * `amount_scale__from`, `amount_currency__from` per the schema convention.
 */
function splitDiscriminator(prefix: string): { base: string; suffix: string } {
  const idx = prefix.indexOf('__')
  if (idx === -1) return { base: prefix, suffix: '' }
  return { base: prefix.slice(0, idx), suffix: prefix.slice(idx) }
}
```

**Step 6: Run tests**

Run: `npx vitest run src/db/__tests__/columnMappers.spec.ts src/db/__tests__/LocalMoment.spec.ts`
Expected: All tests PASS.

**Step 7: Commit**

```
feat: add LocalMoment type and column mappers (Money, LocalMoment, JSON)
```

---

### Task 6: Define entity types in `src/db/types.ts`

**Files:**
- Create: `src/db/types.ts`

Now that `MoneyAmount` and `LocalMoment` exist as standalone types, the entity types in `types.ts` just compose them. No tests of its own — types are validated by the repository tests that follow.

**Step 1: Implement**

```typescript
// src/db/types.ts
import type { MoneyAmount } from './MoneyAmount'
import type { LocalMoment } from './LocalMoment'

export interface Location {
  id: string
  name: string
  description: string | null
  address: string | null
  city: string | null
  country: string | null
  latitude: number | null
  longitude: number | null
  tags: string[]
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface Tag {
  tag: string
  description: string | null
  synonyms: string[]
  colour: string
  icon: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface Account {
  id: string
  name: string
  balance: MoneyAmount
  tags: string[]
  location_id: string | null
  colour: string
  icon: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface ExchangeRate {
  id: string
  date: string                          // 'YYYY-MM-DD'
  base_currency: string
  rates: Record<string, number>
  provider: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface AccountGrouping {
  id: string
  name: string
  colour: string
  icon: string
  accounts_ids: string[]
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface Transaction {
  id: string
  account_id__from: string | null
  account_id__to: string | null
  amount__from: MoneyAmount
  amount__to: MoneyAmount
  transaction_at: LocalMoment
  date_override: LocalMoment | null
  tags: string[]
  location_lat: number | null
  location_lon: number | null
  location_id: string | null
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}
```

**Step 2: Commit**

```
feat: add shared entity types for domain
```

---

### Task 7: TagsRepository

**Files:**
- Create: `src/db/repositories/TagsRepository.ts`
- Create: `src/db/repositories/__tests__/TagsRepository.spec.ts`

**Step 1: Write the test**

Cover: `create` returns the row with timestamps stamped; `findByName` returns null for missing / row for present; `update` patches and bumps `updated_at_utc`; `softDelete` sets `deleted_at_utc` and makes `findByName` return null; `list` returns non-deleted only; `synonyms` JSON column round-trips correctly.

```typescript
// src/db/repositories/__tests__/TagsRepository.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { TagsRepository } from '../TagsRepository'

describe('TagsRepository', () => {
  let db: Database
  let repo: TagsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    repo = new TagsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates and finds a tag', async () => {
    await repo.create({ tag: 'wildberries', description: null, synonyms: ['wb'], colour: '#000', icon: 'cart' })
    const found = await repo.findByName('wildberries')
    expect(found?.synonyms).toEqual(['wb'])
  })

  it('returns null for a missing tag', async () => {
    expect(await repo.findByName('nope')).toBeNull()
  })

  it('updates an existing tag and bumps updated_at_utc', async () => {
    await repo.create({ tag: 'food', synonyms: [], colour: '#FF0', icon: 'cup' })
    const before = (await repo.findByName('food'))!
    await new Promise((r) => setTimeout(r, 5))
    await repo.update('food', { colour: '#0F0' })
    const after = (await repo.findByName('food'))!
    expect(after.colour).toBe('#0F0')
    expect(after.updated_at_utc > before.updated_at_utc).toBe(true)
  })

  it('soft-deletes a tag', async () => {
    await repo.create({ tag: 'temp', synonyms: [], colour: '#FFF', icon: 'x' })
    await repo.softDelete('temp')
    expect(await repo.findByName('temp')).toBeNull()
    const all = await repo.list()
    expect(all).toHaveLength(0)
  })

  it('list() returns only non-deleted', async () => {
    await repo.create({ tag: 'a', synonyms: [], colour: '#000', icon: 'x' })
    await repo.create({ tag: 'b', synonyms: [], colour: '#000', icon: 'x' })
    await repo.softDelete('a')
    const list = await repo.list()
    expect(list.map((t) => t.tag)).toEqual(['b'])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/__tests__/TagsRepository.spec.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

```typescript
// src/db/repositories/TagsRepository.ts
import type { Database } from '../Database'
import type { Tag } from '../types'

interface TagRow {
  tag: string
  description: string | null
  synonyms: string
  colour: string
  icon: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

type TagCreateInput = Pick<Tag, 'tag' | 'colour' | 'icon' | 'synonyms'> & {
  description?: string | null
}

type TagUpdateInput = Partial<Pick<Tag, 'description' | 'synonyms' | 'colour' | 'icon'>>

function rowToTag(row: TagRow): Tag {
  return {
    tag: row.tag,
    description: row.description,
    synonyms: JSON.parse(row.synonyms) as string[],
    colour: row.colour,
    icon: row.icon,
    created_at_utc: row.created_at_utc,
    updated_at_utc: row.updated_at_utc,
    deleted_at_utc: row.deleted_at_utc,
  }
}

export class TagsRepository {
  constructor(private db: Database) {}

  async create(input: TagCreateInput): Promise<Tag> {
    const now = new Date().toISOString()
    await this.db.run(
      `INSERT INTO tags (tag, description, synonyms, colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.tag,
        input.description ?? null,
        JSON.stringify(input.synonyms),
        input.colour,
        input.icon,
        now,
        now,
      ],
    )
    return (await this.findByName(input.tag))!
  }

  async findByName(tag: string): Promise<Tag | null> {
    const rows = await this.db.exec<TagRow>(
      'SELECT * FROM tags WHERE tag = ? AND deleted_at_utc IS NULL',
      [tag],
    )
    return rows.length === 0 ? null : rowToTag(rows[0]!)
  }

  async list(): Promise<Tag[]> {
    const rows = await this.db.exec<TagRow>(
      'SELECT * FROM tags WHERE deleted_at_utc IS NULL ORDER BY tag',
    )
    return rows.map(rowToTag)
  }

  async update(tag: string, patch: TagUpdateInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
    if (patch.synonyms !== undefined)    { sets.push('synonyms = ?');    params.push(JSON.stringify(patch.synonyms)) }
    if (patch.colour !== undefined)      { sets.push('colour = ?');      params.push(patch.colour) }
    if (patch.icon !== undefined)        { sets.push('icon = ?');        params.push(patch.icon) }
    if (sets.length === 0) return
    sets.push('updated_at_utc = ?')
    params.push(new Date().toISOString())
    params.push(tag)
    await this.db.run(`UPDATE tags SET ${sets.join(', ')} WHERE tag = ?`, params)
  }

  async softDelete(tag: string): Promise<void> {
    const now = new Date().toISOString()
    await this.db.run(
      'UPDATE tags SET deleted_at_utc = ?, updated_at_utc = ? WHERE tag = ?',
      [now, now, tag],
    )
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/db/repositories/__tests__/TagsRepository.spec.ts`
Expected: All tests PASS.

**Step 5: Commit**

```
feat: add TagsRepository
```

---

### Task 8: LocationsRepository

**Files:**
- Create: `src/db/repositories/LocationsRepository.ts`
- Create: `src/db/repositories/__tests__/LocationsRepository.spec.ts`

Follow the same pattern as TagsRepository. UUIDv7 ids generated via `newId()`. Test that `tags` JSON column round-trips, that `latitude`/`longitude` are stored as REAL (not stringified), and that `findById` / `list` / `update` / `softDelete` behave the same way as in TagsRepository.

Key difference: `create` accepts a `Partial<Location>`-shaped input without `id`, generates an id via `newId()`, and returns the row.

**Commit:**
```
feat: add LocationsRepository
```

---

### Task 9: AccountsRepository

**Files:**
- Create: `src/db/repositories/AccountsRepository.ts`
- Create: `src/db/repositories/__tests__/AccountsRepository.spec.ts`

Same pattern. Two extra concerns:

1. **Money marshalling.** Create accepts a `MoneyAmount` object; the repo uses `moneyToColumns('balance', balance)` from Task 5 to flatten it into the three `balance_*` columns, and `moneyFromRow('balance', row)` to reconstruct it. Same for JSON columns: `jsonArrayToColumn(tags)` / `jsonArrayFromColumn(row.tags)`.
2. **FK to locations.** Test that creating an account with a `location_id` that doesn't exist fails (FK violation surfaces from `Database.run`).

Test cases to include:
- Create / findById / list
- Update changes only the provided fields and bumps `updated_at_utc`
- Soft delete excludes from `list`
- Creating with non-existent `location_id` throws
- `balance` round-trips for value=1234, scale=2, currency='USD'
- `balance` round-trips for value=100000000, scale=8, currency='BTC' (crypto sanity)

**Commit:**
```
feat: add AccountsRepository
```

---

### Task 10: ExchangeRatesRepository

**Files:**
- Create: `src/db/repositories/ExchangeRatesRepository.ts`
- Create: `src/db/repositories/__tests__/ExchangeRatesRepository.spec.ts`

Standard repo + a `findRates(date, base_currency)` method that returns *all* providers' rates for a given (date, base) — multiple rows are allowed by design, since two providers may both publish USD rates for 2026-05-20.

Test that:
- `rates` JSON object round-trips (e.g., `{ AED: 3.67, EUR: 0.92 }`)
- `findRates('2026-05-20', 'USD')` returns multiple rows when two providers seeded
- Index `idx_exchange_rates_lookup` is used (optional — verify via `EXPLAIN QUERY PLAN`)

**Commit:**
```
feat: add ExchangeRatesRepository
```

---

### Task 11: AccountGroupingsRepository

**Files:**
- Create: `src/db/repositories/AccountGroupingsRepository.ts`
- Create: `src/db/repositories/__tests__/AccountGroupingsRepository.spec.ts`

Standard repo. `accounts_ids` is a JSON array of account UUIDs — no FK constraint (SQLite can't FK-into-JSON). Repo is responsible for validation if needed (out of scope here; treat as a soft reference).

Tests cover create/find/list/update/softDelete, plus `accounts_ids` array round-trip with 0, 1, and many entries.

**Commit:**
```
feat: add AccountGroupingsRepository
```

---

### Task 12: TransactionsRepository

**Files:**
- Create: `src/db/repositories/TransactionsRepository.ts`
- Create: `src/db/repositories/__tests__/TransactionsRepository.spec.ts`

The most complex repo. Concerns:

1. **Two Money triples.** Use the `moneyToColumns` / `moneyFromRow` helpers from Task 5 with prefixes `amount__from` / `amount__to`.
2. **LocalMoment pair.** Helper `localMomentToColumns(prefix, lm)` / `columnsToLocalMoment(prefix, row)` for `transaction_at_*` and `date_override_*` (the latter is nullable).
3. **Nullable FKs.** `account_id__from` and `account_id__to` are both nullable independently; test all four combinations (both set / from-null / to-null / both-null — though both-null is semantically weird, the DB still allows it).
4. **List filters.** Provide at least `listByAccountId(id)` returning transactions where the account appears on either leg.

Tests:
- Round-trip a "normal" transaction (transfer between two own accounts).
- Round-trip an "income from Global Economy" transaction (`account_id__from IS NULL`).
- Round-trip a "spend into Global Economy" transaction (`account_id__to IS NULL`).
- Round-trip a transaction with `date_override` set.
- Round-trip a transaction with location lat/lon only (no location_id).
- Round-trip a transaction with location_id set.
- FK violation on bad account id throws.
- FK violation on bad location_id throws.
- `listByAccountId` returns transactions on either leg, excludes soft-deleted.
- Soft delete sets `deleted_at_utc` and excludes from `findById`.

**Commit:**
```
feat: add TransactionsRepository
```

---

### Task 13: Wire all repositories into `src/db/init.ts`

**Files:**
- Modify: `src/db/init.ts`

Add module-level singletons for each new repository and `get*Repository()` getters that mirror `getSettingsRepository()`. Update `initDatabase()` to instantiate them all after migrations run.

```typescript
// src/db/init.ts (relevant additions)
import { TagsRepository } from './repositories/TagsRepository'
import { LocationsRepository } from './repositories/LocationsRepository'
import { AccountsRepository } from './repositories/AccountsRepository'
import { ExchangeRatesRepository } from './repositories/ExchangeRatesRepository'
import { AccountGroupingsRepository } from './repositories/AccountGroupingsRepository'
import { TransactionsRepository } from './repositories/TransactionsRepository'

let tagsRepository: TagsRepository | null = null
let locationsRepository: LocationsRepository | null = null
let accountsRepository: AccountsRepository | null = null
let exchangeRatesRepository: ExchangeRatesRepository | null = null
let accountGroupingsRepository: AccountGroupingsRepository | null = null
let transactionsRepository: TransactionsRepository | null = null

// In initDatabase(), after runMigrations(...):
tagsRepository = new TagsRepository(database)
locationsRepository = new LocationsRepository(database)
accountsRepository = new AccountsRepository(database)
exchangeRatesRepository = new ExchangeRatesRepository(database)
accountGroupingsRepository = new AccountGroupingsRepository(database)
transactionsRepository = new TransactionsRepository(database)

// Plus six getter functions following the existing getSettingsRepository() pattern.
```

**Commit:**
```
feat: wire domain repositories into database init
```

---

### Task 14: Promote SQLite conventions into CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

The conventions and gotchas we w
+orked out for this schema (affinity audit, `__` discriminator, `_local`/`_zone` timestamp pair, BigDecimal triples, JSON `CHECK (json_valid)`, FK pragma) are currently only documented in this plan. Once Task 1–13 are complete and the conventions have survived first use, fold them into the existing `### SQLite Conventions` section of `CLAUDE.md` so they apply to future schema work without needing to re-read this plan.

**Step 1: Expand the `### SQLite Conventions` section**

Replace the current short list with a fuller version. Suggested content (adapt as the schema teaches us more):

- **Primary keys:** UUIDv7 in `TEXT PRIMARY KEY` columns, generated client-side via `src/db/uuid.ts`. Never declare `UUID` — that string contains no affinity keyword, so the column resolves to BLOB affinity. Exception: natural string keys like `tags.tag` are allowed.
- **Type affinity awareness:** SQLite has only five affinities (NULL, INTEGER, REAL, TEXT, BLOB) and assigns them by keyword-matching the declared type string. `BOOLEAN` resolves to NUMERIC (silent coercion); `TIMESTAMPTZ`, `JSON`, `DECIMAL` resolve to NUMERIC or BLOB depending on keywords inside. **Always declare columns using the explicit affinity-keyword types: TEXT, INTEGER, REAL, BLOB.** Use a comment to record the semantic intent (e.g., `id TEXT PRIMARY KEY  -- UUIDv7`).
- **Timestamps — two kinds:**
  - **`_utc` suffix** — TEXT, ISO 8601 with `Z`. A pure UTC instant. Used for system metadata (`created_at_utc`, `updated_at_utc`, `deleted_at_utc`).
  - **`_local` + `_zone` suffix pair** — TEXT, offset-bearing ISO 8601 (`...+04:00`) plus IANA zone name. A civil moment anchored to a place. Used when the user's wall-clock-at-that-place matters (e.g., `transaction_at_local` + `transaction_at_zone`).
- **Money:** every monetary amount is a triple `<name>_value INTEGER`, `<name>_scale INTEGER`, `<name>_currency TEXT`. Mirrors `BigDecimal(unscaledValue, scale)` plus a free-form currency tag (ISO 4217 or custom for crypto). Frontend formatting uses accounting.js.
- **Soft delete:** every domain table carries `deleted_at_utc TEXT` (nullable). Repositories filter `deleted_at_utc IS NOT NULL` out by default. Required for Phase 2 timestamp-merge sync.
- **Foreign keys:** declared with `ON DELETE RESTRICT`. `PRAGMA foreign_keys = ON` is set in `Database.init()` — SQLite has FK enforcement off by default.
- **JSON columns:** stored as TEXT with `CHECK (json_valid(col))` so malformed writes fail at insert time. Read/write via `JSON.parse`/`JSON.stringify` in repositories; query in SQL via `json_each` / `json_extract`.
- **Naming:**
  - Single underscore separates words and also pairs of columns that hold parts of one value (`latitude` / `longitude`, `transaction_at_local` / `transaction_at_zone`).
  - Double underscore `__` separates a column's base name from a *discriminator suffix*, used only when 2+ parallel columns share one logical grouping. Example: `amount_value__from` / `amount_value__to`, `account_id__from` / `account_id__to`.
- **Migrations:** ordered `.ts` files (`NNN_name.ts`), each exporting `{ version, up }`. Registered in `src/db/init.ts`'s `allMigrations` array. Tracked in the `migrations` table.
- **No concurrent DB operations.** (Unchanged from existing CLAUDE.md note.)

**Step 2: Commit**

```
docs: expand SQLite conventions in CLAUDE.md
```

---

### Task 15: Full sweep — tests, lint, type-check, build

**Step 1:** `npx vitest run` — all tests PASS.
**Step 2:** `npm run type-check` — no errors.
**Step 3:** `npm run lint` — no errors (or only pre-existing).
**Step 4:** `npm run build` — succeeds.

If anything regressed, fix and commit:

```
fix: resolve lint/type/build issues from domain schema and CLAUDE.md update
```

---

## Followups (not part of this plan)

- Backfill an "exchange rate fetcher" task that pulls from openexchangerates and fawazahmed0 and upserts into `exchange_rates` with the right `provider` tag.
- Pinia stores for accounts / transactions, mirroring the layout store's write-through pattern.
- Phase 1 sync (blob upload of the whole `.sqlite` to Supabase, debounced).
- Phase 2 sync (per-row timestamp merge using `updated_at_utc` and `deleted_at_utc`).
- Supabase metadata table: stores the sqlite file hash + last-modified, separate from the file blob, so polling for changes doesn't require downloading the file.
- Promote the new naming conventions (`__` discriminator, `_local`/`_zone` timestamp pair) into CLAUDE.md once they've survived first use.
