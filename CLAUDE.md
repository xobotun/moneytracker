# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal money tracker application. Must work as a standalone app on PCs and mobiles, with cloud sync.

## Tech Stack

- **Frontend:** Vue 3 (Composition API) + TypeScript, built with Vite
- **Sync:** pluggable remote storage, one provider active at a time — GitHub repository (CSV files `data/<table>-NNNN.csv`, ≤1000 rows each, via the REST Git Data API; `ROWS_PER_CSV_FILE` is a fixed constant — never change it, see its comment), Supabase Storage or S3-compatible (one `.sqlite` blob + metadata sidecar). See `src/sync/`. Supabase auth / PostgreSQL: planned, not used yet.
- **Package manager:** npm
- **Architecture:** Offline-first — app works standalone, syncs to the chosen provider when online

### Styling & UI
- **Tailwind CSS v4** for utility-first styling (~90% of CSS).
- **PrimeVue** as primary component library (data tables, forms, date pickers).
- **Radix Vue** for custom headless components when PrimeVue is too opinionated *(planned — not installed yet)*.
- Vue `<style scoped>` for edge cases only.

### UI rules
- **Clickable things look clickable.** Every action is a PrimeVue `Button` (`text` + `severity="secondary"` for low emphasis), so it gets the shared hover and focus states — never a bare icon or plain text with a click handler. Custom pickers (icon tiles, colour swatches) need a visible hover state too.
- **Icon buttons carry a text label where there is room.** Show the label on wide screens and keep only the icon on narrow ones: `label="Edit"` plus `:pt="{ label: { class: 'hidden sm:inline' } }"`. Always give an `aria-label` that names the target (`Edit Cash`).

### Data & State
- **Pinia** for state management — used as a **write-through cache**. SQLite is the source of truth; Pinia stores call repositories to persist changes, then update reactive state. Exception: purely visual preferences (the layout store) save optimistically — show the new value at once, persist, revert and report on failure. Financial data is always write-through.
- **wa-sqlite + IDBBatchAtomicVFS** for local SQLite database (IndexedDB-backed, offline, exportable).
- **Vue Router** for navigation.
- **Per-device state** — sync identity (device name), provider credentials, last-known remote state and the last sync error — lives in localStorage under the `moneytracker.sync.` prefix (`src/sync/localState/`). Reads must tolerate unavailable or malformed storage (fall back to defaults). Together with the SQLite `settings` table and the `exchange_rates` library (see Sync tables) this is device-local and never synced.

### SQLite Conventions

- **Type affinity awareness.** SQLite has only five affinities (NULL, INTEGER, REAL, TEXT, BLOB) and picks one by keyword-matching the declared type string. `BOOLEAN`, `TIMESTAMPTZ`, `JSON`, `DECIMAL`, `UUID` are *not* honored as you'd expect from PostgreSQL — `UUID` contains no affinity keyword and silently resolves to **BLOB**; `BOOLEAN` resolves to NUMERIC and silently coerces. **Always declare columns with one of the five affinity-keyword types** (TEXT, INTEGER, REAL, BLOB), and record the semantic intent in a comment (e.g., `id TEXT PRIMARY KEY  -- UUIDv7`).
- **Primary keys.** UUIDv7 in `TEXT PRIMARY KEY` columns, generated client-side via `src/db/uuid.ts` (`newId()`). Time-ordered so they also sort chronologically. Natural string keys are allowed where they're truly the entity's identity (e.g., `tags.tag`). Rows that two devices may create independently for the same natural key get a deterministic UUIDv5 via `nameBasedId(...)` instead (e.g. `applied_rates`: date + currency pair), so sync merges them as one row.
- **Two kinds of timestamps, distinguished by suffix:**
  - **`_utc` suffix** → TEXT, ISO 8601 UTC with `Z` (e.g., `2026-03-15T14:30:00.000Z`). A pure **instant**. Used for system metadata (`created_at_utc`, `updated_at_utc`, `deleted_at_utc`). Lexicographic order = chronological order.
  - **`_local` + `_zone` suffix pair** → TEXT, offset-bearing ISO 8601 (e.g., `2013-10-07T04:23:19.120+04:00`) plus IANA zone name (e.g., `Europe/Berlin`). A **civil moment anchored to a place**. Used when the user's wall-clock-at-that-place matters (e.g., `transaction_at_local` + `transaction_at_zone`). Both fields are needed because the offset alone doesn't identify the zone (DST, multi-zone offsets). Never sort or compare `_local` values as text — offsets differ; use `julianday(col)` (see `TRANSACTION_ORDER_BY` and the matching expression indexes).
- **Money** is stored as a BigDecimal-style triplet: `<name>_value INTEGER` + `<name>_scale INTEGER` + `<name>_currency TEXT`. Mirrors `BigDecimal(unscaledValue, scale)` plus a free-form currency tag (ISO 4217 or custom like `BTC`). Avoids floating-point drift and works for crypto without a separate currencies table. The `MoneyAmount` TS type and `moneyToColumns` / `moneyFromRow` mappers live in `src/db/MoneyAmount.ts` and `src/db/columnMappers.ts`. Frontend formatting: `formatMoney` (exact amounts) / `formatApprox` (converted ones) in `src/format/currency.ts`, on `Intl.NumberFormat` — symbol where one exists, the currency's usual decimals, never fewer than stored (accounting.js was planned; it is not needed). Exact sums: `sumMoney`; converting for display: `src/money/` — `RateTable` (one day of `applied_rates`) and `totalView`. Converted amounts are approximations, never stored; only rates are. Rates follow docs/plans/2026-10-25-exchange-rates-decisions.md: providers with a `priority` from `src/money/levels.ts` (`providers.ts`: the central banks from the rates repo xobotun/exchange-rates, then fawazahmed0; the same levels rank sync conflicts), the pure rules in `resolveRate.ts`, and `RateService` (`rateService.ts`), which fills the synced `applied_rates` (one row per day and pair; `provider = 'manual'` is an override) from the device-local `exchange_rates` library, fetching what is missing outside any database transaction. Values are JS `number`s for now (fiat only); big crypto amounts are a later decision.
- **Sync columns on every domain table:** `created_at_utc TEXT NOT NULL`, `updated_at_utc TEXT NOT NULL`, `deleted_at_utc TEXT` (nullable). Soft delete via `deleted_at_utc IS NOT NULL`; repositories filter it out by default. Required so Phase 2 timestamp-merge sync can correctly propagate deletes — without a tombstone, a row deleted on device A would resurrect when device B syncs back its older copy. (Not on `settings` / `migrations`: those are device-local and excluded from sync.)
- **Foreign keys** are declared with `ON DELETE RESTRICT`. `PRAGMA foreign_keys = ON` is set in `Database.init()` — SQLite has FK enforcement off by default. Soft-deletes don't trigger FK checks; only a true `DELETE FROM` would, and that's what we want to catch.
- **JSON columns** (arrays like `tags`, `synonyms`; objects like `exchange_rates.rates`) are stored as `TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(col))`. The CHECK uses SQLite's JSON1 module to reject malformed writes at insert time. Read/write via the `jsonArray*` / `jsonObject*` helpers in `src/db/columnMappers.ts`; query in SQL via `json_each` / `json_extract`.
- **Column naming:**
  - Single underscore separates words, including when one logical value is split into two related columns (`latitude` / `longitude`, `transaction_at_local` / `transaction_at_zone`).
  - Double underscore `__` separates a column's base name from a **discriminator suffix**, used only when 2+ parallel columns share one logical grouping. Example: `amount_value__from` / `amount_value__to`, `account_id__from` / `account_id__to`. Rule of thumb: if removing the suffix would name a real concept and there are 2+ parallel suffixed variants, use `__`. Otherwise use `_`.
- **Migrations:** ordered `NNN_name.ts` files exporting `{ version, up }`, registered in the single `ALL_MIGRATIONS` list in `src/db/migrations/index.ts` (also used by the GitHub backend to build downloaded databases — never keep a second list). Tracked in the `migrations` table; each runs in one transaction; applied by `initDatabase()`. Start each `up` with a statement keyword, not a comment (`Database.mutationCounter` classifies writes by their leading keyword). While the app is in development with no real data, existing migrations may be edited in place — reset local IndexedDB and any test remote afterwards.
- **Concurrency.** The async wa-sqlite build (used for IDBBatchAtomicVFS persistence) relies on Asyncify, which cannot handle multiple in-flight operations on one connection. `Database` therefore queues every `exec`/`run` behind an internal lock, so concurrent single statements (including `Promise.all`) are safe. What is *not* safe is a multi-statement unit built from separate calls (`BEGIN` … `COMMIT`): other callers' statements can land in between. Use `db.transaction(async (tx) => …)`, which holds the lock for the whole unit, and use only `tx` inside it (calling `db.exec`/`db.run` there deadlocks). `tx` calls are queued in call order, so `Promise.all` over them is safe. Keep transaction bodies short and local: never await network work (fetches, lazy `import()`s) inside one — the lock it holds freezes every other query of the app.
- **Sync tables.** Every domain table must be listed in `SYNC_TABLES` (`src/sync/syncTables.ts`, parents before children) and described in `SYNC_COLUMNS` (`src/sync/syncColumns.ts`), or it silently won't sync or be hashed. The one deliberate exception is `exchange_rates`, the device-local reference library: it can always be downloaded again (it still rides along, never merged, in a SQLite-blob upload). `syncColumns.spec.ts` checks the descriptors against the real schema. Optional free-text columns store `''` as NULL (`optionalTextToColumn`): the GitHub CSV format cannot tell the two apart.
- **Cached (derived) columns.** `accounts.balance_value` / `balance_scale` cache each account's balance in its own currency, computed from its live transactions — for display and for adding up totals only, **never** as financial truth (the transactions are). `recalculateBalances` (`src/db/balances.ts`) rebuilds them: on every transaction write (inside the same database transaction), after every sync merge, and on demand (Accounts page / account dialog). Cache writes never bump `updated_at_utc` — a refresh is not an edit and must not win a merge against one. Such columns are listed in `DERIVED_COLUMNS` (`src/sync/syncColumns.ts`): the merge comparison and the database hash skip them, so a stale cache on one device is neither a conflict nor a difference. A new derived column goes there too, with its rebuild wired into `mergeDatabases`. `EQUALITY_IGNORED_COLUMNS` (derived columns plus the timestamps of rows each device computes on its own, like `applied_rates`) is what the merge comparison and the hash actually skip, and `ROW_RANK` lets some rows win a conflict whatever the timestamps (an applied rate: manual > direct > cross > none found).
- **Prefer specific domain types over primitives in `src/db/types.ts`.** Identifiers are `UUID` (branded string from `src/db/uuid.ts`), not raw `string`. Instants are `Date`, not raw `string`. Money is `MoneyAmount`, not three loose fields. Civil moments are `LocalMoment`. SQLite still stores TEXT/INTEGER/REAL underneath — the conversion lives at the repository boundary using the helpers in `src/db/columnMappers.ts` (`instantToColumn`/`instantFromColumn`, `uuidFromColumn`/`uuidFromNullableColumn`, `moneyToColumns`/`moneyFromRow`, `localMomentToColumns`/`localMomentFromRow`, `jsonArray*`/`jsonObject*`). When adding a new value type, define it in its own module and add a matching pair of mappers; repositories should never marshal raw strings/numbers if a richer type exists for the concept.

### Quality
- **oxlint** + **ESLint** (+ Prettier) for linting/formatting. `npm run lint` runs both with `--fix` on purpose (auto-fixing saves agent time).
- **Vitest** + Vue Test Utils for unit/component tests. `npm run test:live` runs `*.live.spec.ts` against real services (credentials in the git-ignored `.env.test.local`); they are excluded from `test:unit` and CI.
- **Playwright** for E2E tests.

### CI/CD & Hosting
- **GitHub Actions**: lint + type-check + unit tests on PR, deploy on merge (the e2e suite is not in CI yet).
- **GitHub Pages** for hosting (static PWA). The build copies `index.html` to `404.html` so deep links work.

## Requirements

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full list. Key domain concepts:

- Multi-account, multi-currency expense/income/transfer tracking.
- Dual-currency transactions (account currency vs. purchase currency) with exchange rate history.
- Tags with synonyms, categories, location, date overrides, named time periods.
- Aggregation across many dimensions (time, tags, accounts, currencies, cash/non-cash).
- Bank statement and push notification import.

## Repository

- Remote: https://github.com/xobotun/moneytracker.git
- Branch: main
