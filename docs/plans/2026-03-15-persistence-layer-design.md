# Persistence Layer Design

Date: 2026-03-15
Status: **COMPLETED** — Implemented with IDBBatchAtomicVFS instead of OPFS. All OPFS references in this document are outdated; the actual implementation uses IndexedDB-backed persistence via IDBBatchAtomicVFS (see commit dc38b6b).

## Context

First persistence milestone for the moneytracker app. Goal: validate the wa-sqlite + OPFS pipeline by persisting settings. No Supabase, no domain schema yet.

## Scope

- Local SQLite via wa-sqlite + OPFS
- Persist layout/settings to SQLite
- Pinia as write-through cache (SQLite is source of truth)
- Schema designed to be sync-friendly for future blob-sync and later timestamp-based merge

## Sync Strategy (Future, Out of Scope Now)

1. **Phase 1 (future):** Blob sync — upload entire `.sqlite` file to Supabase Storage after each edit (debounced ~30s). No concurrent multi-device editing.
2. **Phase 2 (future):** Timestamp-based merge — download remote database, compare `updated_at_utc` per row, merge newer entries, re-upload. Requires per-row UUIDs and timestamps (built into schema from day one).

The `Database` class is a regular class (not a singleton) so a second instance can be opened against a downloaded remote file for merge operations.

## Database Layer (`src/db/Database.ts`)

A TypeScript class managing the wa-sqlite OPFS connection:

- `init()` — load WASM module, open/create OPFS-backed database, run migrations
- `exec(sql, params): Row[]` — execute a query, return rows
- `run(sql, params): { changes, lastInsertRowId }` — execute a statement
- `close()` — shut down cleanly

Database file lives in OPFS at `/moneytracker.db`.

## Migrations (`src/db/migrations/`)

Simple version-tracked migrations:

```sql
CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  applied_at_utc TEXT NOT NULL
);
```

Each migration is a `.ts` file exporting SQL strings. On `init()`, unapplied migrations run in order.

## Settings Schema (`src/db/migrations/001_settings.ts`)

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
```

- `value` is JSON-serialized text (handles strings, numbers, booleans, objects)
- `updated_at_utc` is ISO 8601 with `Z` suffix (e.g., `2026-03-15T14:30:00.000Z`)

## Repository (`src/db/repositories/SettingsRepository.ts`)

Takes a `Database` instance in constructor. Methods:

- `get<T>(key): T | null` — fetch and JSON.parse
- `set<T>(key, value): void` — JSON.stringify and upsert (INSERT OR REPLACE)
- `getAll(): Record<string, unknown>` — bulk load for app startup
- `delete(key): void`

## Pinia Integration

Pinia stores are write-through caches:

1. Store actions call `SettingsRepository.set()` first
2. Then update the reactive ref
3. On app startup, `SettingsRepository.getAll()` hydrates stores before Vue mounts

Settings keys use dot-namespace convention: `layout.navPosition`, `layout.collapseMode`, etc.

### Initialization Flow

```
main.ts → Database.init() → run migrations → load settings into Pinia → mount Vue app
```

App does not mount until database is ready — no flash of default state.

## File Structure

```
src/db/
  Database.ts
  migrations/
    index.ts            — migration runner
    001_settings.ts     — settings table
  repositories/
    SettingsRepository.ts
src/stores/
  layout.ts             — modified to use SettingsRepository
```

The `db/` module is pure TypeScript with no Vue/Pinia dependency. Repositories are testable in isolation.

## SQLite Conventions

- **Primary keys:** UUIDs (TEXT), generated client-side
- **Timestamps:** ISO 8601 UTC with `Z` suffix. Column names use `_utc` suffix (e.g., `updated_at_utc`)
- **Migrations:** Ordered `.ts` files, tracked in `migrations` table