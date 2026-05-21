# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal money tracker application. Must work as a standalone app on PCs and mobiles, with cloud sync.

## Tech Stack

- **Frontend:** Vue 3 (Composition API) + TypeScript, built with Vite
- **Backend:** Supabase (auth, PostgreSQL, sync)
- **Package manager:** npm
- **Architecture:** Offline-first — app works standalone, syncs to Supabase when online

### Styling & UI
- **Tailwind CSS v4** for utility-first styling (~90% of CSS).
- **PrimeVue** as primary component library (data tables, forms, date pickers).
- **Radix Vue** for custom headless components when PrimeVue is too opinionated.
- Vue `<style scoped>` for edge cases only.

### Data & State
- **Pinia** for state management — used as a **write-through cache**. SQLite is the source of truth; Pinia stores call repositories to persist changes, then update reactive state.
- **wa-sqlite + IDBBatchAtomicVFS** for local SQLite database (IndexedDB-backed, offline, exportable).
- **Vue Router** for navigation.

### SQLite Conventions

- **Type affinity awareness.** SQLite has only five affinities (NULL, INTEGER, REAL, TEXT, BLOB) and picks one by keyword-matching the declared type string. `BOOLEAN`, `TIMESTAMPTZ`, `JSON`, `DECIMAL`, `UUID` are *not* honored as you'd expect from PostgreSQL — `UUID` contains no affinity keyword and silently resolves to **BLOB**; `BOOLEAN` resolves to NUMERIC and silently coerces. **Always declare columns with one of the five affinity-keyword types** (TEXT, INTEGER, REAL, BLOB), and record the semantic intent in a comment (e.g., `id TEXT PRIMARY KEY  -- UUIDv7`).
- **Primary keys.** UUIDv7 in `TEXT PRIMARY KEY` columns, generated client-side via `src/db/uuid.ts` (`newId()`). Time-ordered so they also sort chronologically. Natural string keys are allowed where they're truly the entity's identity (e.g., `tags.tag`).
- **Two kinds of timestamps, distinguished by suffix:**
  - **`_utc` suffix** → TEXT, ISO 8601 UTC with `Z` (e.g., `2026-03-15T14:30:00.000Z`). A pure **instant**. Used for system metadata (`created_at_utc`, `updated_at_utc`, `deleted_at_utc`). Lexicographic order = chronological order.
  - **`_local` + `_zone` suffix pair** → TEXT, offset-bearing ISO 8601 (e.g., `2013-10-07T04:23:19.120+04:00`) plus IANA zone name (e.g., `Europe/Berlin`). A **civil moment anchored to a place**. Used when the user's wall-clock-at-that-place matters (e.g., `transaction_at_local` + `transaction_at_zone`). Both fields are needed because the offset alone doesn't identify the zone (DST, multi-zone offsets).
- **Money** is stored as a BigDecimal-style triplet: `<name>_value INTEGER` + `<name>_scale INTEGER` + `<name>_currency TEXT`. Mirrors `BigDecimal(unscaledValue, scale)` plus a free-form currency tag (ISO 4217 or custom like `BTC`). Avoids floating-point drift and works for crypto without a separate currencies table. The `MoneyAmount` TS type and `moneyToColumns` / `moneyFromRow` mappers live in `src/db/MoneyAmount.ts` and `src/db/columnMappers.ts`. Frontend formatting uses [accounting.js](https://openexchangerates.github.io/accounting.js/).
- **Sync columns on every domain table:** `created_at_utc TEXT NOT NULL`, `updated_at_utc TEXT NOT NULL`, `deleted_at_utc TEXT` (nullable). Soft delete via `deleted_at_utc IS NOT NULL`; repositories filter it out by default. Required so Phase 2 timestamp-merge sync can correctly propagate deletes — without a tombstone, a row deleted on device A would resurrect when device B syncs back its older copy.
- **Foreign keys** are declared with `ON DELETE RESTRICT`. `PRAGMA foreign_keys = ON` is set in `Database.init()` — SQLite has FK enforcement off by default. Soft-deletes don't trigger FK checks; only a true `DELETE FROM` would, and that's what we want to catch.
- **JSON columns** (arrays like `tags`, `synonyms`, `accounts_ids`; objects like `exchange_rates.rates`) are stored as `TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(col))`. The CHECK uses SQLite's JSON1 module to reject malformed writes at insert time. Read/write via the `jsonArray*` / `jsonObject*` helpers in `src/db/columnMappers.ts`; query in SQL via `json_each` / `json_extract`.
- **Column naming:**
  - Single underscore separates words, including when one logical value is split into two related columns (`latitude` / `longitude`, `transaction_at_local` / `transaction_at_zone`).
  - Double underscore `__` separates a column's base name from a **discriminator suffix**, used only when 2+ parallel columns share one logical grouping. Example: `amount_value__from` / `amount_value__to`, `account_id__from` / `account_id__to`. Rule of thumb: if removing the suffix would name a real concept and there are 2+ parallel suffixed variants, use `__`. Otherwise use `_`.
- **Migrations:** ordered `NNN_name.ts` files exporting `{ version, up }`. Registered in `src/db/init.ts`'s `allMigrations` array. Tracked in the `migrations` table. Run automatically on `Database.init()`.
- **No concurrent DB operations.** The async wa-sqlite build (used for IDBBatchAtomicVFS persistence) relies on Asyncify, which cannot handle multiple in-flight operations on the same connection. Always `await` each query sequentially — never use `Promise.all` with multiple DB calls.

### Quality
- **ESLint** + **Prettier** for linting/formatting.
- **Vitest** + Vue Test Utils for unit/component tests.
- **Playwright** for E2E tests.

### CI/CD & Hosting
- **GitHub Actions**: lint + test on PR, deploy on merge.
- **GitHub Pages** for hosting (static PWA).

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

## Developer Context

- Author is experienced in Java/Go (~9 YoE) but new to frontend/JavaScript ecosystem.
- Prefer explicit, clear code over clever JS idioms. Explain non-obvious JS/Vue patterns when introducing them.
