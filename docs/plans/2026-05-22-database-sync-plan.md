# Database Sync — Merge Engine & Orchestration Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline-testable core of database sync — a row-level merge engine with conflict resolution and a sync orchestrator implementing the scenario decisions from `docs/scenarios/2026-05-22-database-sync-scenarios.md`.

**Architecture:** A new `src/sync/` module. The merge engine operates on two open `Database` instances (local + a copy of remote) and merges rows table-by-table in foreign-key order, resolving conflicts by delete-wins / latest-timestamp-wins. The orchestrator wires scenario decisions, a schema-version gate, and a compare-and-swap upload loop. Network access and `.sqlite` blob serialization are abstracted behind two interfaces — `SyncProvider` and `DatabaseCodec` — so the whole core is unit-testable with in-memory fakes.

**Tech Stack:** TypeScript, wa-sqlite (via the existing `Database` class), Vitest. No new dependencies.

**Out of scope — deferred to a follow-up plan ("Database Sync — Provider & UI"):**
- The real `SyncProvider` (Supabase / Backblaze / GitHub — provider still unchosen per `TASKS.md`).
- The real `DatabaseCodec` (`VACUUM INTO` + `MemoryVFS` export/import — see the `reference_sqlite_export` memory).
- Network / metered-connection detection.
- The UI: blocking overlay during sync, "use the local database" interrupt button, the Settings "Sync now" button.
- The conflict-notification email (needs a Supabase Edge Function).

This plan produces a complete, fully-tested sync core. The follow-up plan only supplies the two real adapters and the Vue UI; it changes no logic written here.

---

## File Structure

All new files live under `src/sync/`:

- `types.ts` — shared type definitions (`SyncMetadata`, `RemoteState`, `SyncConflict`, `SyncRow`, …). No logic.
- `localState.ts` — device identity + last-known-remote-state, persisted in `localStorage` (deliberately *outside* the synced database, so they are never carried in the uploaded blob).
- `schemaVersion.ts` — read a database's migration version; decide the schema-gate action.
- `syncTables.ts` — the ordered list of domain tables to merge, parents before children.
- `rows.ts` — generic row helpers: read, compare, classify, upsert.
- `resolveConflict.ts` — pure conflict-resolution rule.
- `mergeEngine.ts` — `mergeTable` (one table) and `mergeDatabases` (all tables, one transaction).
- `SyncProvider.ts` — interface for remote storage with a compare-and-swap upload.
- `DatabaseCodec.ts` — interface for `.sqlite` blob export / import / hashing.
- `syncOrchestrator.ts` — `decideSync` (pure scenario logic) and `runSync` (the full algorithm).
- `__tests__/helpers.ts` — test helpers: build a migrated in-memory DB, seed rows.
- `__tests__/fakes.ts` — `FakeSyncProvider`, `FakeDatabaseCodec` for orchestrator tests.
- `__tests__/*.spec.ts` — one spec file per module above.

Why this split: each file has one responsibility and stays small enough to reason about whole. `rows.ts` is shared by both the merge engine and the fake codec, so it lives on its own. The two interface files are tiny but separate because they mark the seam where the deferred follow-up plan plugs in.

---

## Conventions for this plan

- Tests are `src/sync/__tests__/<name>.spec.ts`, mirroring `src/db/__tests__/`.
- Run a single spec file with `npx vitest run src/sync/__tests__/<name>.spec.ts`.
- `Database` operations must be `await`ed one at a time — wa-sqlite's Asyncify build cannot handle concurrent calls on one connection (see `CLAUDE.md`). Never `Promise.all` two DB calls.
- Timestamps are ISO 8601 UTC strings; lexicographic order equals chronological order, so plain `<` / `>=` string comparison is correct for them.
- Commit at the end of each task with a `feat:` / `test:` conventional-commit message.

---

### Task 1: Sync types & local bookkeeping store

**Files:**
- Create: `src/sync/types.ts`
- Create: `src/sync/localState.ts`
- Test: `src/sync/__tests__/localState.spec.ts`

- [ ] **Step 1: Create the shared types file**

Create `src/sync/types.ts`:

```typescript
// Shared type definitions for the database sync module.
// See docs/scenarios/2026-05-22-database-sync-scenarios.md.

/** A raw database row: column name → value, exactly as `SELECT *` returns it. */
export type SyncRow = Record<string, unknown>

/** Metadata stored alongside the remote database blob. */
export interface SyncMetadata {
  /** Device id of the device that produced this upload. */
  device: string
  /** When the upload happened — ISO 8601 UTC. */
  uploadedAtUtc: string
  /** Hash of the uploaded database blob. */
  hash: string
  /** Schema (migration) version of the uploaded database. */
  migrationVersion: number
}

/** What a device recorded locally at its last successful sync. */
export interface RemoteState {
  device: string
  uploadedAtUtc: string
  hash: string
}

/** How a row-level conflict was resolved. */
export type ConflictResolution = 'delete-wins' | 'latest-update-wins'

/** A row that was modified on both sides since the merge cutoff. */
export interface SyncConflict {
  table: string
  primaryKey: string
  local: SyncRow
  remote: SyncRow
  winner: 'local' | 'remote'
  resolution: ConflictResolution
}

/** Outcome of a sync run, surfaced to the caller (UI lands in the follow-up plan). */
export type SyncOutcomeDecision =
  | 'none' // scenario 1 — databases identical
  | 'first-sync-upload' // remote was empty
  | 'upload-local' // scenario 2.1 — this device was the last uploader
  | 'merge' // scenario 2.2 — merged a foreign upload
  | 'aborted-app-outdated' // remote schema newer than this app

export interface SyncOutcome {
  decision: SyncOutcomeDecision
  conflicts: SyncConflict[]
  uploaded: boolean
}

/** Lower bound used as the merge cutoff when no prior sync watermark exists. */
export const EPOCH_UTC = '1970-01-01T00:00:00.000Z'
```

- [ ] **Step 2: Write the failing test for `localState`**

Create `src/sync/__tests__/localState.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { getDeviceId, loadLastKnownRemoteState, saveLastKnownRemoteState } from '../localState'

describe('localState', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('mints a device id once and returns the same id afterwards', () => {
    const first = getDeviceId()
    const second = getDeviceId()
    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('returns null when no remote state has been saved', () => {
    expect(loadLastKnownRemoteState()).toBeNull()
  })

  it('round-trips the last known remote state', () => {
    const state = { device: 'dev-1', uploadedAtUtc: '2026-05-22T10:00:00.000Z', hash: 'abc' }
    saveLastKnownRemoteState(state)
    expect(loadLastKnownRemoteState()).toEqual(state)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/localState.spec.ts`
Expected: FAIL — cannot resolve `../localState`.

- [ ] **Step 4: Implement `localState`**

Create `src/sync/localState.ts`:

```typescript
import { newId } from '../db/uuid'
import type { RemoteState } from './types'

// Sync bookkeeping is stored in localStorage, NOT in the SQLite database.
// The whole database is uploaded as one blob, so anything in a SQLite table
// would be carried to every other device. The device id must stay unique
// per device, so it must live outside the synced data.

const DEVICE_ID_KEY = 'moneytracker.sync.deviceId'
const REMOTE_STATE_KEY = 'moneytracker.sync.lastKnownRemoteState'

/** Returns this device's stable id, minting and persisting one on first call. */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = newId()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

/** The remote state recorded at the last successful sync, or null if never synced. */
export function loadLastKnownRemoteState(): RemoteState | null {
  const raw = localStorage.getItem(REMOTE_STATE_KEY)
  return raw ? (JSON.parse(raw) as RemoteState) : null
}

/** Persists the remote state to compare against on the next sync. */
export function saveLastKnownRemoteState(state: RemoteState): void {
  localStorage.setItem(REMOTE_STATE_KEY, JSON.stringify(state))
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/localState.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/sync/types.ts src/sync/localState.ts src/sync/__tests__/localState.spec.ts
git commit -m "feat: add sync types and localStorage bookkeeping store"
```

---

### Task 2: Schema version reader & schema gate

**Files:**
- Create: `src/sync/schemaVersion.ts`
- Test: `src/sync/__tests__/schemaVersion.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/schemaVersion.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { readSchemaVersion, decideSchemaAction } from '../schemaVersion'

describe('readSchemaVersion', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('returns 0 for a database with no migrations applied', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL)')
    expect(await readSchemaVersion(db)).toBe(0)
  })

  it('returns the highest applied migration version', async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    expect(await readSchemaVersion(db)).toBe(2)
  })
})

describe('decideSchemaAction', () => {
  it('merges directly when versions match', () => {
    expect(decideSchemaAction(2, 2)).toBe('merge')
  })

  it('migrates the remote copy when it is older', () => {
    expect(decideSchemaAction(3, 2)).toBe('migrate-remote-then-merge')
  })

  it('aborts when the remote is newer than this app', () => {
    expect(decideSchemaAction(2, 3)).toBe('abort-app-outdated')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/schemaVersion.spec.ts`
Expected: FAIL — cannot resolve `../schemaVersion`.

- [ ] **Step 3: Implement `schemaVersion`**

Create `src/sync/schemaVersion.ts`:

```typescript
import type { Database } from '../db/Database'

/** What to do about a schema-version difference before merging. */
export type SchemaAction = 'merge' | 'migrate-remote-then-merge' | 'abort-app-outdated'

/** Highest applied migration version in `db`, or 0 if none applied. */
export async function readSchemaVersion(db: Database): Promise<number> {
  const rows = await db.exec<{ v: number | null }>('SELECT MAX(version) AS v FROM migrations')
  return rows[0]?.v ?? 0
}

/**
 * Decide the schema gate (algorithm step 3):
 *  - remote newer than this app  → abort, the user must update the app
 *  - remote older                → migrate the downloaded copy, then merge
 *  - equal                       → merge directly
 */
export function decideSchemaAction(localVersion: number, remoteVersion: number): SchemaAction {
  if (remoteVersion > localVersion) return 'abort-app-outdated'
  if (remoteVersion < localVersion) return 'migrate-remote-then-merge'
  return 'merge'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/schemaVersion.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/schemaVersion.ts src/sync/__tests__/schemaVersion.spec.ts
git commit -m "feat: add schema-version reader and schema gate decision"
```

---

### Task 3: Sync table descriptors

**Files:**
- Create: `src/sync/syncTables.ts`
- Test: `src/sync/__tests__/syncTables.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/syncTables.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { SYNC_TABLES } from '../syncTables'

describe('SYNC_TABLES', () => {
  it('lists every domain table exactly once', () => {
    const names = SYNC_TABLES.map((t) => t.name)
    expect(new Set(names)).toEqual(
      new Set(['locations', 'tags', 'exchange_rates', 'account_groupings', 'accounts', 'transactions']),
    )
    expect(names).toHaveLength(6)
  })

  it('orders foreign-key parents before their children', () => {
    const order = SYNC_TABLES.map((t) => t.name)
    // accounts reference locations; transactions reference accounts and locations.
    expect(order.indexOf('locations')).toBeLessThan(order.indexOf('accounts'))
    expect(order.indexOf('accounts')).toBeLessThan(order.indexOf('transactions'))
    expect(order.indexOf('locations')).toBeLessThan(order.indexOf('transactions'))
  })

  it('uses "tag" as the primary key for the tags table and "id" elsewhere', () => {
    const byName = Object.fromEntries(SYNC_TABLES.map((t) => [t.name, t.pk]))
    expect(byName.tags).toBe('tag')
    expect(byName.accounts).toBe('id')
    expect(byName.transactions).toBe('id')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/syncTables.spec.ts`
Expected: FAIL — cannot resolve `../syncTables`.

- [ ] **Step 3: Implement `syncTables`**

Create `src/sync/syncTables.ts`:

```typescript
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
 */
export const SYNC_TABLES: readonly SyncTable[] = [
  { name: 'locations', pk: 'id' },
  { name: 'tags', pk: 'tag' },
  { name: 'exchange_rates', pk: 'id' },
  { name: 'account_groupings', pk: 'id' },
  { name: 'accounts', pk: 'id' },
  { name: 'transactions', pk: 'id' },
]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/syncTables.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/syncTables.ts src/sync/__tests__/syncTables.spec.ts
git commit -m "feat: add ordered sync table descriptors"
```

---

### Task 4: Generic row helpers

**Files:**
- Create: `src/sync/rows.ts`
- Test: `src/sync/__tests__/rows.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/rows.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { readRows, rowsEqual, isDeleted, effectiveTimestamp, changedSince, upsertRow } from '../rows'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

describe('row helpers', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('readRows returns every row of a table', async () => {
    db = await migratedDb()
    await db.run(
      'INSERT INTO locations (id, name, created_at_utc, updated_at_utc) VALUES (?, ?, ?, ?)',
      ['loc-1', 'Home', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'],
    )
    const rows = await readRows(db, 'locations')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('loc-1')
  })

  it('rowsEqual compares all columns', () => {
    expect(rowsEqual({ id: 'a', name: 'X' }, { id: 'a', name: 'X' })).toBe(true)
    expect(rowsEqual({ id: 'a', name: 'X' }, { id: 'a', name: 'Y' })).toBe(false)
  })

  it('isDeleted reflects deleted_at_utc', () => {
    expect(isDeleted({ deleted_at_utc: null })).toBe(false)
    expect(isDeleted({ deleted_at_utc: '2026-05-01T00:00:00.000Z' })).toBe(true)
  })

  it('effectiveTimestamp prefers deleted_at_utc over updated_at_utc', () => {
    expect(
      effectiveTimestamp({ updated_at_utc: '2026-05-01T00:00:00.000Z', deleted_at_utc: null }),
    ).toBe('2026-05-01T00:00:00.000Z')
    expect(
      effectiveTimestamp({
        updated_at_utc: '2026-05-01T00:00:00.000Z',
        deleted_at_utc: '2026-05-02T00:00:00.000Z',
      }),
    ).toBe('2026-05-02T00:00:00.000Z')
  })

  it('changedSince is true when any timestamp is newer than the cutoff', () => {
    const cutoff = '2026-05-01T00:00:00.000Z'
    expect(
      changedSince(
        { created_at_utc: '2026-04-01T00:00:00.000Z', updated_at_utc: '2026-06-01T00:00:00.000Z', deleted_at_utc: null },
        cutoff,
      ),
    ).toBe(true)
    expect(
      changedSince(
        { created_at_utc: '2026-04-01T00:00:00.000Z', updated_at_utc: '2026-04-01T00:00:00.000Z', deleted_at_utc: null },
        cutoff,
      ),
    ).toBe(false)
  })

  it('upsertRow inserts a new row and overwrites an existing one', async () => {
    db = await migratedDb()
    const row = {
      id: 'loc-9',
      name: 'First',
      description: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      tags: '[]',
      created_at_utc: '2026-05-01T00:00:00.000Z',
      updated_at_utc: '2026-05-01T00:00:00.000Z',
      deleted_at_utc: null,
    }
    await upsertRow(db, 'locations', 'id', row)
    await upsertRow(db, 'locations', 'id', { ...row, name: 'Second' })
    const rows = await readRows(db, 'locations')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Second')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/rows.spec.ts`
Expected: FAIL — cannot resolve `../rows`.

- [ ] **Step 3: Implement `rows`**

Create `src/sync/rows.ts`:

```typescript
import type { Database } from '../db/Database'
import type { SyncRow } from './types'

/** Reads every row of `table` as raw column maps. */
export async function readRows(db: Database, table: string): Promise<SyncRow[]> {
  // `table` always comes from the SYNC_TABLES constant, never user input.
  return db.exec<SyncRow>(`SELECT * FROM ${table}`)
}

/** True when two rows have identical values for every column. */
export function rowsEqual(a: SyncRow, b: SyncRow): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/** True when the row carries a soft-delete tombstone. */
export function isDeleted(row: SyncRow): boolean {
  return row.deleted_at_utc != null
}

/**
 * The timestamp that decides recency for a row: its delete time if deleted,
 * otherwise its last update time. Both are ISO 8601 UTC strings.
 */
export function effectiveTimestamp(row: SyncRow): string {
  return (row.deleted_at_utc as string | null) ?? (row.updated_at_utc as string)
}

/** True when the row was created, updated, or deleted after `cutoff`. */
export function changedSince(row: SyncRow, cutoff: string): boolean {
  const created = row.created_at_utc as string
  const updated = row.updated_at_utc as string
  const deleted = row.deleted_at_utc as string | null
  return created > cutoff || updated > cutoff || (deleted != null && deleted > cutoff)
}

/**
 * Inserts `row` into `table`, or overwrites the existing row with the same
 * primary key. Uses SQLite UPSERT (`ON CONFLICT DO UPDATE`) rather than
 * `INSERT OR REPLACE`: REPLACE deletes the old row first, which would trip
 * `ON DELETE RESTRICT` foreign keys when the row is referenced.
 */
export async function upsertRow(
  db: Database,
  table: string,
  pk: string,
  row: SyncRow,
): Promise<void> {
  const cols = Object.keys(row)
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols
    .filter((c) => c !== pk)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  await db.run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(${pk}) DO UPDATE SET ${updates}`,
    cols.map((c) => row[c]),
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/rows.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/rows.ts src/sync/__tests__/rows.spec.ts
git commit -m "feat: add generic row read/compare/upsert helpers"
```

---

### Task 5: Conflict resolution rule

**Files:**
- Create: `src/sync/resolveConflict.ts`
- Test: `src/sync/__tests__/resolveConflict.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/resolveConflict.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveConflict } from '../resolveConflict'

const alive = (updated: string) => ({ updated_at_utc: updated, deleted_at_utc: null })
const deleted = (at: string) => ({ updated_at_utc: at, deleted_at_utc: at })

describe('resolveConflict', () => {
  it('lets a delete win over a concurrent update regardless of timestamps', () => {
    const local = deleted('2026-05-01T00:00:00.000Z')
    const remote = alive('2026-05-09T00:00:00.000Z') // newer, but only an update
    expect(resolveConflict(local, remote)).toEqual({ winner: 'local', resolution: 'delete-wins' })
  })

  it('lets the remote delete win over a local update', () => {
    const local = alive('2026-05-09T00:00:00.000Z')
    const remote = deleted('2026-05-01T00:00:00.000Z')
    expect(resolveConflict(local, remote)).toEqual({ winner: 'remote', resolution: 'delete-wins' })
  })

  it('picks the latest update when neither side is deleted', () => {
    const local = alive('2026-05-01T00:00:00.000Z')
    const remote = alive('2026-05-02T00:00:00.000Z')
    expect(resolveConflict(local, remote)).toEqual({
      winner: 'remote',
      resolution: 'latest-update-wins',
    })
  })

  it('picks the latest delete when both sides are deleted', () => {
    const local = deleted('2026-05-05T00:00:00.000Z')
    const remote = deleted('2026-05-03T00:00:00.000Z')
    expect(resolveConflict(local, remote)).toEqual({
      winner: 'local',
      resolution: 'latest-update-wins',
    })
  })

  it('breaks an exact timestamp tie in favour of local, deterministically', () => {
    const local = alive('2026-05-01T00:00:00.000Z')
    const remote = alive('2026-05-01T00:00:00.000Z')
    expect(resolveConflict(local, remote)).toEqual({
      winner: 'local',
      resolution: 'latest-update-wins',
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/resolveConflict.spec.ts`
Expected: FAIL — cannot resolve `../resolveConflict`.

- [ ] **Step 3: Implement `resolveConflict`**

Create `src/sync/resolveConflict.ts`:

```typescript
import type { ConflictResolution, SyncRow } from './types'
import { effectiveTimestamp, isDeleted } from './rows'

export interface ConflictResult {
  winner: 'local' | 'remote'
  resolution: ConflictResolution
}

/**
 * Resolve a row modified on both sides since the merge cutoff
 * (see "Conflict resolution" in the sync scenarios doc):
 *  1. If exactly one side deleted the row, the delete wins — keep the tombstone.
 *  2. Otherwise the side with the latest updated/deleted timestamp wins.
 *  3. An exact tie goes to local, so the result is deterministic.
 */
export function resolveConflict(local: SyncRow, remote: SyncRow): ConflictResult {
  const localDeleted = isDeleted(local)
  const remoteDeleted = isDeleted(remote)

  if (localDeleted && !remoteDeleted) return { winner: 'local', resolution: 'delete-wins' }
  if (remoteDeleted && !localDeleted) return { winner: 'remote', resolution: 'delete-wins' }

  const winner = effectiveTimestamp(local) >= effectiveTimestamp(remote) ? 'local' : 'remote'
  return { winner, resolution: 'latest-update-wins' }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/resolveConflict.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/resolveConflict.ts src/sync/__tests__/resolveConflict.spec.ts
git commit -m "feat: add row conflict resolution rule"
```

---

### Task 6: Single-table merge + shared test helpers

**Files:**
- Create: `src/sync/mergeEngine.ts`
- Create: `src/sync/__tests__/helpers.ts`
- Test: `src/sync/__tests__/mergeTable.spec.ts`

- [ ] **Step 1: Create the shared test helpers**

Create `src/sync/__tests__/helpers.ts`:

```typescript
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
```

- [ ] **Step 2: Write the failing test for `mergeTable`**

Create `src/sync/__tests__/mergeTable.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import { mergeTable } from '../mergeEngine'
import { readRows } from '../rows'
import { newMigratedDb, seedLocation } from './helpers'

const LOCATIONS = { name: 'locations', pk: 'id' }
const CUTOFF = '2026-05-01T00:00:00.000Z'

describe('mergeTable', () => {
  let local: Database
  let remote: Database

  afterEach(async () => {
    if (local) await local.close()
    if (remote) await remote.close()
  })

  it('keeps a row that exists only locally', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, { id: 'a', name: 'Local only', created: CUTOFF, updated: CUTOFF })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
    expect(await readRows(local, 'locations')).toHaveLength(1)
  })

  it('inserts a row that exists only remotely', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(remote, { id: 'b', name: 'Remote only', created: CUTOFF, updated: CUTOFF })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
    const rows = await readRows(local, 'locations')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Remote only')
  })

  it('takes the remote version when only the remote changed since the cutoff', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, { id: 'c', name: 'Old', created: CUTOFF, updated: CUTOFF })
    await seedLocation(remote, {
      id: 'c',
      name: 'New from remote',
      created: CUTOFF,
      updated: '2026-05-10T00:00:00.000Z',
    })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
    expect((await readRows(local, 'locations'))[0]!.name).toBe('New from remote')
  })

  it('keeps the local version when only the local changed since the cutoff', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, {
      id: 'd',
      name: 'New from local',
      created: CUTOFF,
      updated: '2026-05-10T00:00:00.000Z',
    })
    await seedLocation(remote, { id: 'd', name: 'Old', created: CUTOFF, updated: CUTOFF })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
    expect((await readRows(local, 'locations'))[0]!.name).toBe('New from local')
  })

  it('reports a conflict and applies the winner when both sides changed', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, {
      id: 'e',
      name: 'Local edit',
      created: CUTOFF,
      updated: '2026-05-05T00:00:00.000Z',
    })
    await seedLocation(remote, {
      id: 'e',
      name: 'Remote edit',
      created: CUTOFF,
      updated: '2026-05-08T00:00:00.000Z', // newer → remote wins
    })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!).toMatchObject({ table: 'locations', primaryKey: 'e', winner: 'remote' })
    expect((await readRows(local, 'locations'))[0]!.name).toBe('Remote edit')
  })

  it('does not report a conflict when both sides hold an identical row', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, { id: 'f', name: 'Same', created: CUTOFF, updated: CUTOFF })
    await seedLocation(remote, { id: 'f', name: 'Same', created: CUTOFF, updated: CUTOFF })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/mergeTable.spec.ts`
Expected: FAIL — cannot resolve `../mergeEngine`.

- [ ] **Step 4: Implement `mergeTable`**

Create `src/sync/mergeEngine.ts`:

```typescript
import type { Database } from '../db/Database'
import type { SyncConflict, SyncRow } from './types'
import type { SyncTable } from './syncTables'
import { changedSince, readRows, rowsEqual, upsertRow } from './rows'
import { resolveConflict } from './resolveConflict'

/** Index a list of rows by the string value of their primary key column. */
function indexByPk(rows: SyncRow[], pk: string): Map<string, SyncRow> {
  const map = new Map<string, SyncRow>()
  for (const row of rows) {
    map.set(String(row[pk]), row)
  }
  return map
}

/**
 * Reconcile one table from `remote` into `local`. Applies remote-winning rows
 * to `local` via upsert and returns the conflicts encountered. The caller is
 * responsible for wrapping the writes in a transaction (see `mergeDatabases`).
 *
 * `cutoff` is the last successful sync timestamp; a row counts as "changed"
 * only if it was created/updated/deleted after it.
 */
export async function mergeTable(
  local: Database,
  remote: Database,
  table: SyncTable,
  cutoff: string,
): Promise<SyncConflict[]> {
  const localRows = indexByPk(await readRows(local, table.name), table.pk)
  const remoteRows = indexByPk(await readRows(remote, table.name), table.pk)
  const conflicts: SyncConflict[] = []

  for (const [key, remoteRow] of remoteRows) {
    const localRow = localRows.get(key)

    // Remote-only row → this device has not seen it yet, insert it.
    if (!localRow) {
      await upsertRow(local, table.name, table.pk, remoteRow)
      continue
    }

    // Same row on both sides → nothing to do.
    if (rowsEqual(localRow, remoteRow)) continue

    const localChanged = changedSince(localRow, cutoff)
    const remoteChanged = changedSince(remoteRow, cutoff)

    // Only the remote moved → take the remote version.
    if (remoteChanged && !localChanged) {
      await upsertRow(local, table.name, table.pk, remoteRow)
      continue
    }

    // Only the local moved → keep the local version.
    if (localChanged && !remoteChanged) continue

    // Both moved (or neither did but the rows differ) → conflict.
    const { winner, resolution } = resolveConflict(localRow, remoteRow)
    if (winner === 'remote') {
      await upsertRow(local, table.name, table.pk, remoteRow)
    }
    conflicts.push({ table: table.name, primaryKey: key, local: localRow, remote: remoteRow, winner, resolution })
  }

  // Local-only rows need no action — they stay in `local` and are uploaded as-is.
  return conflicts
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/mergeTable.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/sync/mergeEngine.ts src/sync/__tests__/helpers.ts src/sync/__tests__/mergeTable.spec.ts
git commit -m "feat: add single-table merge engine"
```

---

### Task 7: Full-database merge

**Files:**
- Modify: `src/sync/mergeEngine.ts`
- Test: `src/sync/__tests__/mergeDatabases.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/mergeDatabases.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import { mergeDatabases } from '../mergeEngine'
import { readRows } from '../rows'
import { newMigratedDb, seedLocation, seedAccount, seedTransaction } from './helpers'

const CUTOFF = '2026-05-01T00:00:00.000Z'

describe('mergeDatabases', () => {
  let local: Database
  let remote: Database

  afterEach(async () => {
    if (local) await local.close()
    if (remote) await remote.close()
  })

  it('merges a remote-only account together with the location it references', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    // Parent before child within the remote: location must merge before the account
    // that references it, or the foreign key would fail.
    await seedLocation(remote, { id: 'loc-1', name: 'Bank HQ', created: CUTOFF, updated: CUTOFF })
    await seedAccount(remote, {
      id: 'acc-1',
      name: 'Checking',
      created: CUTOFF,
      updated: CUTOFF,
      locationId: 'loc-1',
    })

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

    expect(conflicts).toHaveLength(0)
    expect(await readRows(local, 'locations')).toHaveLength(1)
    expect(await readRows(local, 'accounts')).toHaveLength(1)
  })

  it('merges a remote-only transaction together with its account', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedAccount(remote, { id: 'acc-2', name: 'Cash', created: CUTOFF, updated: CUTOFF })
    await seedTransaction(remote, {
      id: 'txn-1',
      accountFrom: 'acc-2',
      created: CUTOFF,
      updated: CUTOFF,
    })

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

    expect(conflicts).toHaveLength(0)
    expect(await readRows(local, 'transactions')).toHaveLength(1)
  })

  it('aggregates conflicts across multiple tables', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, { id: 'l', name: 'L-local', created: CUTOFF, updated: '2026-05-05T00:00:00.000Z' })
    await seedLocation(remote, { id: 'l', name: 'L-remote', created: CUTOFF, updated: '2026-05-06T00:00:00.000Z' })
    await seedAccount(local, { id: 'a', name: 'A-local', created: CUTOFF, updated: '2026-05-05T00:00:00.000Z' })
    await seedAccount(remote, { id: 'a', name: 'A-remote', created: CUTOFF, updated: '2026-05-06T00:00:00.000Z' })

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

    expect(conflicts.map((c) => c.table).sort()).toEqual(['accounts', 'locations'])
  })

  it('rolls back the local database when a merge step fails', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(remote, { id: 'ok', name: 'Fine', created: CUTOFF, updated: CUTOFF })
    // A transaction referencing an account that exists nowhere → FK failure mid-merge.
    await seedAccount(remote, { id: 'acc-x', name: 'X', created: CUTOFF, updated: CUTOFF })
    await seedTransaction(remote, { id: 'txn-x', accountFrom: 'acc-x', created: CUTOFF, updated: CUTOFF })
    await remote.run('DELETE FROM accounts WHERE id = ?', ['acc-x'])

    await expect(mergeDatabases(local, remote, CUTOFF)).rejects.toThrow()
    // The earlier, successful location upsert must have been rolled back.
    expect(await readRows(local, 'locations')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/mergeDatabases.spec.ts`
Expected: FAIL — `mergeDatabases` is not exported by `../mergeEngine`.

- [ ] **Step 3: Add `mergeDatabases` to the merge engine**

Append to `src/sync/mergeEngine.ts` (after `mergeTable`):

```typescript
import { SYNC_TABLES } from './syncTables'

/**
 * Reconcile every domain table from `remote` into `local` (algorithm steps
 * 6–7). Tables are merged parents-before-children so foreign keys hold, and
 * all writes run inside one transaction so a crash or failure cannot leave a
 * half-merged database.
 */
export async function mergeDatabases(
  local: Database,
  remote: Database,
  cutoff: string,
): Promise<SyncConflict[]> {
  const conflicts: SyncConflict[] = []
  await local.run('BEGIN')
  try {
    for (const table of SYNC_TABLES) {
      const tableConflicts = await mergeTable(local, remote, table, cutoff)
      conflicts.push(...tableConflicts)
    }
    await local.run('COMMIT')
  } catch (e) {
    await local.run('ROLLBACK')
    throw e
  }
  return conflicts
}
```

Note: keep the existing `import { SYNC_TABLES }` at the top of the file with the other imports rather than mid-file — move the line up to join the import block.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/mergeDatabases.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/mergeEngine.ts src/sync/__tests__/mergeDatabases.spec.ts
git commit -m "feat: add transactional full-database merge"
```

---

### Task 8: Sync provider & database codec interfaces with fakes

**Files:**
- Create: `src/sync/SyncProvider.ts`
- Create: `src/sync/DatabaseCodec.ts`
- Create: `src/sync/__tests__/fakes.ts`
- Test: `src/sync/__tests__/fakes.spec.ts`

- [ ] **Step 1: Create the `SyncProvider` interface**

Create `src/sync/SyncProvider.ts`:

```typescript
import type { SyncMetadata } from './types'

/**
 * Remote storage for the database blob and its metadata. The real
 * implementation (Supabase / Backblaze / GitHub) lands in the follow-up plan;
 * the orchestrator and its tests depend only on this interface.
 */
export interface SyncProvider {
  /** Current remote metadata, or null when no database has ever been uploaded. */
  getMetadata(): Promise<SyncMetadata | null>

  /** The current remote database blob. Rejects if nothing has been uploaded. */
  download(): Promise<Blob>

  /**
   * Compare-and-swap upload (algorithm step 8). Succeeds only if the current
   * remote metadata still equals `expected` (both null for the first upload).
   * Returns true on success, false if another device uploaded in the meantime —
   * the orchestrator then re-merges. Never silently clobbers a foreign upload.
   */
  upload(blob: Blob, metadata: SyncMetadata, expected: SyncMetadata | null): Promise<boolean>
}

/** True when two metadata values are equal for the purpose of the CAS check. */
export function metadataEquals(a: SyncMetadata | null, b: SyncMetadata | null): boolean {
  if (a === null || b === null) return a === b
  return a.device === b.device && a.uploadedAtUtc === b.uploadedAtUtc && a.hash === b.hash
}
```

- [ ] **Step 2: Create the `DatabaseCodec` interface**

Create `src/sync/DatabaseCodec.ts`:

```typescript
import type { Database } from '../db/Database'

/**
 * Serializes a `Database` to an uploadable blob and back. The real
 * implementation (`VACUUM INTO` + `MemoryVFS`, see the `reference_sqlite_export`
 * memory) lands in the follow-up plan; the orchestrator depends only on this
 * interface so it stays unit-testable.
 */
export interface DatabaseCodec {
  /** Serialize a database to a blob suitable for upload. */
  export(db: Database): Promise<Blob>

  /** Open a fresh `Database` from a downloaded blob. Caller closes it. */
  openFromBlob(blob: Blob): Promise<Database>

  /** A stable hash of a blob — equal blobs hash equal. */
  hash(blob: Blob): Promise<string>
}
```

- [ ] **Step 3: Write the failing test for the fakes**

Create `src/sync/__tests__/fakes.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import type { SyncMetadata } from '../types'
import { FakeSyncProvider, FakeDatabaseCodec } from './fakes'
import { readRows } from '../rows'
import { newMigratedDb, seedLocation } from './helpers'
import type { Database } from '../../db/Database'

const META = (over: Partial<SyncMetadata> = {}): SyncMetadata => ({
  device: 'dev-1',
  uploadedAtUtc: '2026-05-22T10:00:00.000Z',
  hash: 'h1',
  migrationVersion: 2,
  ...over,
})

describe('FakeSyncProvider', () => {
  it('starts empty', async () => {
    const p = new FakeSyncProvider()
    expect(await p.getMetadata()).toBeNull()
    await expect(p.download()).rejects.toThrow()
  })

  it('accepts a CAS upload when the expected metadata matches', async () => {
    const p = new FakeSyncProvider()
    expect(await p.upload(new Blob(['x']), META(), null)).toBe(true)
    expect(await p.getMetadata()).toEqual(META())
  })

  it('rejects a CAS upload when the remote moved underneath', async () => {
    const p = new FakeSyncProvider()
    await p.upload(new Blob(['x']), META(), null)
    const stale: SyncMetadata | null = null // caller thinks remote is still empty
    expect(await p.upload(new Blob(['y']), META({ hash: 'h2' }), stale)).toBe(false)
  })
})

describe('FakeDatabaseCodec', () => {
  let db: Database
  let reopened: Database

  afterEach(async () => {
    if (db) await db.close()
    if (reopened) await reopened.close()
  })

  it('round-trips a database through export and openFromBlob', async () => {
    const codec = new FakeDatabaseCodec()
    db = await newMigratedDb()
    await seedLocation(db, {
      id: 'loc-1',
      name: 'Round trip',
      created: '2026-05-01T00:00:00.000Z',
      updated: '2026-05-01T00:00:00.000Z',
    })

    const blob = await codec.export(db)
    reopened = await codec.openFromBlob(blob)

    const rows = await readRows(reopened, 'locations')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Round trip')
  })

  it('hashes equal blobs equally and different blobs differently', async () => {
    const codec = new FakeDatabaseCodec()
    expect(await codec.hash(new Blob(['same']))).toBe(await codec.hash(new Blob(['same'])))
    expect(await codec.hash(new Blob(['a']))).not.toBe(await codec.hash(new Blob(['b'])))
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/fakes.spec.ts`
Expected: FAIL — cannot resolve `./fakes`.

- [ ] **Step 5: Implement the fakes**

Create `src/sync/__tests__/fakes.ts`:

```typescript
import { Database } from '../../db/Database'
import type { SyncProvider } from '../SyncProvider'
import type { DatabaseCodec } from '../DatabaseCodec'
import type { SyncMetadata } from '../types'
import { metadataEquals } from '../SyncProvider'
import { SYNC_TABLES } from '../syncTables'
import { readRows, upsertRow } from '../rows'
import { newMigratedDb } from './helpers'

/** In-memory SyncProvider with real compare-and-swap semantics. */
export class FakeSyncProvider implements SyncProvider {
  private blob: Blob | null = null
  private meta: SyncMetadata | null = null

  /** Test hook: runs inside upload(), before the CAS check, to simulate a
   *  concurrent upload by another device. Set it, then it fires once. */
  beforeUpload: (() => Promise<void>) | null = null

  async getMetadata(): Promise<SyncMetadata | null> {
    return this.meta
  }

  async download(): Promise<Blob> {
    if (!this.blob) throw new Error('FakeSyncProvider: nothing uploaded yet')
    return this.blob
  }

  async upload(blob: Blob, metadata: SyncMetadata, expected: SyncMetadata | null): Promise<boolean> {
    if (this.beforeUpload) {
      const hook = this.beforeUpload
      this.beforeUpload = null
      await hook()
    }
    if (!metadataEquals(this.meta, expected)) return false
    this.blob = blob
    this.meta = metadata
    return true
  }

  /** Test helper: force remote state without a CAS check. */
  forceState(blob: Blob, metadata: SyncMetadata): void {
    this.blob = blob
    this.meta = metadata
  }
}

/**
 * DatabaseCodec that serializes the sync tables to JSON. Good enough for tests
 * and a valid (if unoptimized) implementation; the follow-up plan replaces it
 * with a `VACUUM INTO`-based codec that preserves the whole .sqlite file.
 */
export class FakeDatabaseCodec implements DatabaseCodec {
  async export(db: Database): Promise<Blob> {
    const dump: Record<string, unknown[]> = {}
    for (const table of SYNC_TABLES) {
      dump[table.name] = await readRows(db, table.name)
    }
    return new Blob([JSON.stringify(dump)], { type: 'application/json' })
  }

  async openFromBlob(blob: Blob): Promise<Database> {
    const dump = JSON.parse(await blob.text()) as Record<string, Record<string, unknown>[]>
    const db = await newMigratedDb()
    for (const table of SYNC_TABLES) {
      for (const row of dump[table.name] ?? []) {
        await upsertRow(db, table.name, table.pk, row)
      }
    }
    return db
  }

  async hash(blob: Blob): Promise<string> {
    // FNV-1a over the blob text — deterministic, dependency-free.
    const text = await blob.text()
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16)
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/fakes.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 7: Commit**

```bash
git add src/sync/SyncProvider.ts src/sync/DatabaseCodec.ts src/sync/__tests__/fakes.ts src/sync/__tests__/fakes.spec.ts
git commit -m "feat: add sync provider and database codec interfaces with fakes"
```

---

### Task 9: Sync orchestrator

**Files:**
- Create: `src/sync/syncOrchestrator.ts`
- Test: `src/sync/__tests__/syncOrchestrator.spec.ts`

- [ ] **Step 1: Write the failing test for `decideSync`**

Create `src/sync/__tests__/syncOrchestrator.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import type { SyncMetadata } from '../types'
import { decideSync, runSync } from '../syncOrchestrator'
import { FakeSyncProvider, FakeDatabaseCodec } from './fakes'
import { readRows } from '../rows'
import { newMigratedDb, seedLocation } from './helpers'

const META = (over: Partial<SyncMetadata> = {}): SyncMetadata => ({
  device: 'other-device',
  uploadedAtUtc: '2026-05-20T10:00:00.000Z',
  hash: 'remote-hash',
  migrationVersion: 2,
  ...over,
})

describe('decideSync', () => {
  it('returns "none" when the local hash equals the remote hash', () => {
    expect(decideSync('same', META({ hash: 'same' }), 'dev-A')).toBe('none')
  })

  it('returns "upload-local" when this device was the last uploader and the DBs differ', () => {
    expect(decideSync('local-hash', META({ device: 'dev-A', hash: 'remote-hash' }), 'dev-A')).toBe(
      'upload-local',
    )
  })

  it('returns "merge" when a different device last modified the remote', () => {
    expect(decideSync('local-hash', META({ device: 'dev-B', hash: 'remote-hash' }), 'dev-A')).toBe(
      'merge',
    )
  })
})

describe('runSync', () => {
  let local: Database

  afterEach(async () => {
    if (local) await local.close()
  })

  function deps(provider: FakeSyncProvider) {
    const state: { lastKnown: import('../types').RemoteState | null } = { lastKnown: null }
    return {
      provider,
      codec: new FakeDatabaseCodec(),
      deviceId: 'dev-A',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
      migrate: async () => {},
      loadLastKnown: () => state.lastKnown,
      saveLastKnown: (s: import('../types').RemoteState) => {
        state.lastKnown = s
      },
    }
  }

  it('uploads the local database on first sync when the remote is empty', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()

    const outcome = await runSync(local, deps(provider))

    expect(outcome.decision).toBe('first-sync-upload')
    expect(outcome.uploaded).toBe(true)
    expect(await provider.getMetadata()).not.toBeNull()
  })

  it('does nothing when local and remote already match', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()
    const d = deps(provider)
    const blob = await d.codec.export(local)
    const hash = await d.codec.hash(blob)
    provider.forceState(blob, META({ device: 'dev-B', hash }))

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('none')
    expect(outcome.uploaded).toBe(false)
  })

  it('merges a foreign upload and writes the result back', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()
    const d = deps(provider)
    // Remote, produced by another device, carries a location the local DB lacks.
    const remoteDb = await newMigratedDb()
    await seedLocation(remoteDb, {
      id: 'loc-remote',
      name: 'From device B',
      created: '2026-05-21T00:00:00.000Z',
      updated: '2026-05-21T00:00:00.000Z',
    })
    const remoteBlob = await d.codec.export(remoteDb)
    await remoteDb.close()
    provider.forceState(remoteBlob, META({ device: 'dev-B', hash: await d.codec.hash(remoteBlob) }))

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('merge')
    expect(outcome.uploaded).toBe(true)
    expect(await readRows(local, 'locations')).toHaveLength(1)
  })

  it('re-merges when a concurrent upload makes the first CAS upload fail', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()
    const d = deps(provider)
    const remoteDb = await newMigratedDb()
    await seedLocation(remoteDb, {
      id: 'loc-1',
      name: 'Initial remote',
      created: '2026-05-21T00:00:00.000Z',
      updated: '2026-05-21T00:00:00.000Z',
    })
    const remoteBlob = await d.codec.export(remoteDb)
    await remoteDb.close()
    provider.forceState(remoteBlob, META({ device: 'dev-B', hash: await d.codec.hash(remoteBlob) }))

    // Simulate device C uploading once, during our first upload attempt.
    provider.beforeUpload = async () => {
      const otherDb = await newMigratedDb()
      await seedLocation(otherDb, {
        id: 'loc-2',
        name: 'Sneaked in',
        created: '2026-05-21T12:00:00.000Z',
        updated: '2026-05-21T12:00:00.000Z',
      })
      const blob = await d.codec.export(otherDb)
      await otherDb.close()
      provider.forceState(blob, META({ device: 'dev-C', hash: await d.codec.hash(blob) }))
    }

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('merge')
    expect(outcome.uploaded).toBe(true)
    // Both the original remote row and the sneaked-in row survived the re-merge.
    expect((await readRows(local, 'locations')).map((r) => r.id).sort()).toEqual(['loc-1', 'loc-2'])
  })

  it('aborts when the remote schema is newer than this app', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()
    const d = deps(provider)
    const remoteDb = await newMigratedDb()
    const remoteBlob = await d.codec.export(remoteDb)
    await remoteDb.close()
    provider.forceState(
      remoteBlob,
      META({ device: 'dev-B', hash: await d.codec.hash(remoteBlob), migrationVersion: 99 }),
    )

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('aborted-app-outdated')
    expect(outcome.uploaded).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/syncOrchestrator.spec.ts`
Expected: FAIL — cannot resolve `../syncOrchestrator`.

- [ ] **Step 3: Implement the orchestrator**

Create `src/sync/syncOrchestrator.ts`:

```typescript
import type { Database } from '../db/Database'
import type { RemoteState, SyncMetadata, SyncOutcome } from './types'
import { EPOCH_UTC } from './types'
import type { SyncProvider } from './SyncProvider'
import type { DatabaseCodec } from './DatabaseCodec'
import { readSchemaVersion, decideSchemaAction } from './schemaVersion'
import { mergeDatabases } from './mergeEngine'

/** Scenario decision from "2. Sync needed" of the sync scenarios doc. */
export type SyncDecision = 'none' | 'upload-local' | 'merge'

/**
 * Pure scenario logic:
 *  - hashes equal                       → "none"      (scenario 1)
 *  - hashes differ, this device uploaded last → "upload-local" (scenario 2.1)
 *  - hashes differ, another device uploaded last → "merge"     (scenario 2.2)
 */
export function decideSync(
  localHash: string,
  remoteMeta: SyncMetadata,
  deviceId: string,
): SyncDecision {
  if (localHash === remoteMeta.hash) return 'none'
  if (remoteMeta.device === deviceId) return 'upload-local'
  return 'merge'
}

/** Everything `runSync` needs, injected so the orchestrator stays testable. */
export interface SyncDeps {
  provider: SyncProvider
  codec: DatabaseCodec
  deviceId: string
  /** Current time — injectable so tests are deterministic. */
  now: () => Date
  /** Brings a downloaded older-schema database up to the current schema. */
  migrate: (db: Database) => Promise<void>
  loadLastKnown: () => RemoteState | null
  saveLastKnown: (state: RemoteState) => void
}

function remoteStateOf(meta: SyncMetadata): RemoteState {
  return { device: meta.device, uploadedAtUtc: meta.uploadedAtUtc, hash: meta.hash }
}

/**
 * Runs the full sync algorithm (see docs/scenarios/2026-05-22-database-sync-scenarios.md).
 * Mutates `localDb` in place when a merge happens. The caller closes `localDb`.
 */
export async function runSync(localDb: Database, deps: SyncDeps): Promise<SyncOutcome> {
  const localVersion = await readSchemaVersion(localDb)
  const localBlob = await deps.codec.export(localDb)
  const localHash = await deps.codec.hash(localBlob)
  const remoteMeta = await deps.provider.getMetadata()

  const stamp = (hash: string): SyncMetadata => ({
    device: deps.deviceId,
    uploadedAtUtc: deps.now().toISOString(),
    hash,
    migrationVersion: localVersion,
  })

  // First sync — the remote has no database yet. Nothing to merge; upload local.
  if (remoteMeta === null) {
    const meta = stamp(localHash)
    await deps.provider.upload(localBlob, meta, null)
    deps.saveLastKnown(remoteStateOf(meta))
    return { decision: 'first-sync-upload', conflicts: [], uploaded: true }
  }

  const decision = decideSync(localHash, remoteMeta, deps.deviceId)

  // Scenario 1 — databases already identical.
  if (decision === 'none') {
    deps.saveLastKnown(remoteStateOf(remoteMeta))
    return { decision: 'none', conflicts: [], uploaded: false }
  }

  // Scenario 2.1 — this device was the last uploader; remote has nothing
  // foreign, so just upload the local database.
  if (decision === 'upload-local') {
    const meta = stamp(localHash)
    const ok = await deps.provider.upload(localBlob, meta, remoteMeta)
    if (ok) {
      deps.saveLastKnown(remoteStateOf(meta))
      return { decision: 'upload-local', conflicts: [], uploaded: true }
    }
    // Remote moved underneath us → restart; it is now a foreign upload to merge.
    return runSync(localDb, deps)
  }

  // Scenario 2.2 — merge a foreign upload, then compare-and-swap the result.
  let expected = remoteMeta
  for (;;) {
    const schemaAction = decideSchemaAction(localVersion, expected.migrationVersion)
    if (schemaAction === 'abort-app-outdated') {
      return { decision: 'aborted-app-outdated', conflicts: [], uploaded: false }
    }

    const remoteBlob = await deps.provider.download()
    const remoteDb = await deps.codec.openFromBlob(remoteBlob)
    try {
      if (schemaAction === 'migrate-remote-then-merge') {
        await deps.migrate(remoteDb)
      }
      const cutoff = deps.loadLastKnown()?.uploadedAtUtc ?? EPOCH_UTC
      const conflicts = await mergeDatabases(localDb, remoteDb, cutoff)

      const mergedBlob = await deps.codec.export(localDb)
      const mergedHash = await deps.codec.hash(mergedBlob)
      const meta = stamp(mergedHash)

      const ok = await deps.provider.upload(mergedBlob, meta, expected)
      if (ok) {
        deps.saveLastKnown(remoteStateOf(meta))
        return { decision: 'merge', conflicts, uploaded: true }
      }
      // Another device uploaded during our merge — re-merge against the new remote.
      const fresh = await deps.provider.getMetadata()
      if (fresh === null) throw new Error('runSync: remote metadata disappeared mid-sync')
      expected = fresh
    } finally {
      await remoteDb.close()
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/syncOrchestrator.spec.ts`
Expected: PASS — 9 tests (3 `decideSync` + 6 `runSync`).

- [ ] **Step 5: Run the whole sync suite and the type checker**

Run: `npx vitest run src/sync && npm run type-check`
Expected: All sync specs PASS; `type-check` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sync/syncOrchestrator.ts src/sync/__tests__/syncOrchestrator.spec.ts
git commit -m "feat: add sync orchestrator with scenario decisions and CAS loop"
```

---

## Self-review notes

Checked against `docs/scenarios/2026-05-22-database-sync-scenarios.md`:

- **Scenario 1 (no sync needed)** → `decideSync` returns `'none'` on equal hashes; first-sync / empty-remote handled by the `remoteMeta === null` branch of `runSync`.
- **Scenario 2.1 (this device last uploader)** → `decideSync` returns `'upload-local'`; `runSync` uploads with a CAS guard.
- **Scenario 2.2 (foreign upload)** → `'merge'` path: schema gate → download → merge → CAS upload → re-merge on conflict.
- **Algorithm step 2 (expected remote state)** → captured in `expected`, threaded into `provider.upload`.
- **Step 3 (schema gate)** → `decideSchemaAction`; newer-remote abort returns `'aborted-app-outdated'`.
- **Step 5 (merge cutoff)** → `loadLastKnown()?.uploadedAtUtc ?? EPOCH_UTC`.
- **Step 6 (FK-ordered merge)** → `SYNC_TABLES` order + `mergeTable`/`mergeDatabases`.
- **Step 7 (single atomic transaction)** → `BEGIN`/`COMMIT`/`ROLLBACK` in `mergeDatabases`, verified by the rollback test.
- **Step 8 (CAS upload + re-merge)** → the `for (;;)` loop with `metadataEquals`, verified by the concurrent-upload test.
- **Step 9 (update last known remote state)** → `saveLastKnown` on every successful path.
- **Conflict resolution** → `resolveConflict`: delete-wins, then latest-timestamp-wins; conflicts are collected and returned in `SyncOutcome.conflicts` (the email consumer is deferred).

Deferred deliberately and stated in "Out of scope": real `SyncProvider`, real `DatabaseCodec`, network detection, UI blocking/interrupt, Settings button, conflict email. Type names (`SyncMetadata`, `RemoteState`, `SyncConflict`, `SyncTable`, `SchemaAction`, `SyncDecision`, `SyncOutcome`) are defined once and used consistently across tasks.
