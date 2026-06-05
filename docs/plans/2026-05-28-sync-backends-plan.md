# Sync Backends — GitHub-CSV and SQLite-Blob Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two `SyncBackend` implementations described in
[`docs/plans/2026-05-28-sync-backends-design.md`](2026-05-28-sync-backends-design.md):
`GitHubCsvBackend` (CSV per domain table, REST data API, git as the change log) and
`SqliteBlobBackend` (`.sqlite` blob, with Supabase Storage and S3-compatible transports).
Also: refactor the already-shipped sync core's external seam to a single
`SyncBackend` interface, add a shared content-based `hashDatabase`, and surface a minimal
"Sync now" button + per-provider "Validate" buttons in the existing Settings UI.

**Architecture:** Replace `SyncProvider` + `DatabaseCodec` with one `SyncBackend`
interface returning open `Database` instances; the orchestrator never sees how many
files a backend stores. CSV path uses PapaParse for serialisation and one bulk
`INSERT … SELECT … FROM json_each(?)` per table for import (one Asyncify yield-point
per table instead of one per row). Blob path uses `VACUUM INTO` + MemoryVFS. Hashing
is provider-independent and content-based, cached per-`Database` via a new
`mutationCounter`.

**Tech Stack:** TypeScript, Vue 3 Composition API (existing), wa-sqlite + JSON1
(existing — `json_each` is compiled in), PapaParse (new), aws4fetch (new — sig v4
for S3-compatible transport), Vitest (existing).

**Design reference:** [`docs/plans/2026-05-28-sync-backends-design.md`](2026-05-28-sync-backends-design.md).
Every task below is grounded in that design. Where this plan says "see the design
doc," read it before writing code; the design carries reasoning the plan compresses.

**Out of scope** — handled by follow-up plans:
- App-launch automatic fetch populating `lastFetchedRemoteSnapshot`.
- Blocking sync overlay + "use the local database" interrupt button.
- Network state / metered-connection detection, auto-sync triggers.
- Conflict-notification email (needs a Supabase Edge Function).
- Garbage collection of orphan blobs in S3 buckets after CAS misses.

---

## File Structure

```
src/sync/
  SyncProvider.ts                   ← DELETE
  DatabaseCodec.ts                  ← DELETE
  SyncBackend.ts                    ← NEW (interface)
  hashDatabase.ts                   ← NEW (shared content hash + cache)
  syncColumns.ts                    ← NEW (per-table column type descriptors)
  csvCodec.ts                       ← NEW (CSV ↔ Database)
  sqliteBlobCodec.ts                ← NEW (Blob ↔ Database)
  GitHubTransport.ts                ← NEW (HTTP wrapper for GitHub REST data API)
  GitHubCsvBackend.ts               ← NEW (backend impl)
  BlobTransport.ts                  ← NEW (interface for blob transports)
  SupabaseStorageTransport.ts       ← NEW (Supabase Storage impl of BlobTransport)
  S3Transport.ts                    ← NEW (S3-compatible impl via aws4fetch)
  SqliteBlobBackend.ts              ← NEW (backend impl)
  backendFactory.ts                 ← NEW (ProviderConfig → SyncBackend)
  syncOrchestrator.ts               ← MODIFY (SyncDeps.backend; runSync rewrite)
  types.ts                          ← unchanged
  rows.ts                           ← unchanged
  resolveConflict.ts                ← unchanged
  mergeEngine.ts                    ← unchanged
  syncTables.ts                     ← unchanged
  schemaVersion.ts                  ← unchanged
  localState/
    syncError.ts                    ← NEW
    providerConfig.ts               ← MODIFY (drop github.path field + default)
    index.ts                        ← MODIFY (export syncError)
    storage.ts                      ← unchanged
    deviceName.ts                   ← unchanged
    remoteSnapshots.ts              ← unchanged
  __tests__/
    fakes.ts                        ← MODIFY (FakeSyncBackend replaces two old fakes;
                                       add FakeGitHubTransport + FakeBlobTransport)
    fakes.spec.ts                   ← MODIFY (test the new fakes)
    syncOrchestrator.spec.ts        ← MODIFY (deps factory uses backend)
    hashDatabase.spec.ts            ← NEW
    syncColumns.spec.ts             ← NEW
    csvCodec.spec.ts                ← NEW
    sqliteBlobCodec.spec.ts         ← NEW
    GitHubTransport.spec.ts         ← NEW
    GitHubCsvBackend.spec.ts        ← NEW
    SqliteBlobBackend.spec.ts       ← NEW
    SupabaseStorageTransport.spec.ts ← NEW
    S3Transport.spec.ts             ← NEW
    backendFactory.spec.ts          ← NEW
    localState/
      syncError.spec.ts             ← NEW
      providerConfig.spec.ts        ← MODIFY (remove github.path tests)

src/db/
  Database.ts                       ← MODIFY (add mutationCounter)
  init.ts                           ← MODIFY (setSyncBackend / getSyncBackend
                                       replace setDatabaseCodec / getDatabaseCodec;
                                       app-launch backend construction)
  __tests__/
    Database.spec.ts                ← MODIFY (mutationCounter tests)

src/views/
  SettingsView.vue                  ← MODIFY (Validate buttons + Sync now button +
                                       error display)
  useSyncSettings.ts                ← MODIFY (take backend not codec; expose
                                       syncNow + lastSyncError)
  __tests__/
    useSyncSettings.spec.ts         ← MODIFY (use FakeSyncBackend; cover syncNow)

package.json                        ← MODIFY (add papaparse, aws4fetch,
                                       @types/papaparse)
TASKS.md                            ← MODIFY (move chunks 1+2 + minimal UI to Done)
REQUIREMENTS.md                     ← MODIFY (mark sync line as satisfied)
```

---

## Conventions for this plan

- Tests are `src/<area>/__tests__/<name>.spec.ts`, mirroring the existing layout.
- Run a single spec with `npx vitest run <path>`. Run the whole suite with
  `npm run test:unit`.
- `Database` operations must be `await`ed one at a time — wa-sqlite's Asyncify build
  cannot handle concurrent calls on one connection (see `CLAUDE.md`). Never
  `Promise.all` two DB calls.
- Timestamps are ISO 8601 UTC strings; lexicographic order equals chronological order,
  so plain `<` / `>=` string comparison is correct.
- Commit at the end of each task. Subject line ≤72 chars, imperative mood, no
  conventional-commit prefix, no trailing period. Body explains *why* + non-obvious
  decisions. End with the `Co-Authored-By: Claude …` trailer.
- TDD: every code-bearing task writes the failing test first, verifies failure, then
  implements. Implementation steps must come AFTER the failing test in this order.
- Do not refactor unrelated code in a task that introduces a new feature. If you spot
  something to clean up, leave it.
- This plan rewrites already-shipped code (`SyncProvider` / `DatabaseCodec` / the
  orchestrator's `SyncDeps`). The 49 tests in `syncOrchestrator.spec.ts` are expected
  to keep passing throughout — if one fails, the refactor is wrong, not the test.

---

## Pointers for the implementing agent

Read these before starting:

- [`docs/plans/2026-05-28-sync-backends-design.md`](2026-05-28-sync-backends-design.md)
  — the design this plan implements. Especially the "Alternatives considered" and
  "Pointers for the implementing agent" sections.
- [`docs/scenarios/2026-05-22-database-sync-scenarios.md`](../scenarios/2026-05-22-database-sync-scenarios.md)
  — scenario logic the orchestrator preserves through this refactor.
- [`CLAUDE.md`](../../CLAUDE.md) — SQLite conventions (affinity, sync-column suffixes,
  money triplets, JSON columns), the "no concurrent DB ops" rule.
- [`src/sync/syncTables.ts`](../../src/sync/syncTables.ts) — FK-ordered table list.
  Import must use this order.
- [`src/sync/rows.ts`](../../src/sync/rows.ts) — `rowsEqual` handles `Uint8Array` byte
  by byte. Reused in round-trip tests.
- [`src/sync/mergeEngine.ts`](../../src/sync/mergeEngine.ts) — algorithm core, do not
  modify.
- MEMORY `reference_sqlite_export.md` — VACUUM INTO + MemoryVFS recipe for the blob
  codec.

Subtle correctness points (cribbed from the design doc — they bear repeating):

- **`hashDatabase` is content-based, not storage-form-based.** Don't accidentally
  hash CSV bytes or `.sqlite` bytes; hash logical rows.
- **`getMetadata()` has a side effect** — it caches whatever CAS handle the backend
  needs for the next `tryUpload`. Calling `tryUpload` without a prior `getMetadata`
  is a programming error and throws.
- **Schema gate runs only on the `merge` branch** of `decideSync`. The codec must not
  silently drop unknown CSV columns; the gate catches "remote is newer than this app."
- **CSV row order must be deterministic.** `ORDER BY <pk>`. Without this two devices
  with the same logical DB produce different CSVs.
- **`VACUUM INTO` writes to a *target* file**, not the source. The source DB's
  `mutationCounter` should be unchanged across export. Verify by test.

---

## Task 1: Add `mutationCounter` to `Database`

**Files:**
- Modify: `src/db/Database.ts`
- Test: `src/db/__tests__/Database.spec.ts`

A monotonic counter on the `Database` class, bumped by the `run()` write path. Used
by `hashDatabase()` (added in the next task) to skip re-hashing when nothing has
changed since the last call. Cheap: a keyword check on the leading token of the SQL.

- [ ] **Step 1: Read the existing `Database` class**

Read `src/db/Database.ts` end-to-end. Note that `run()` is the write path and `exec()`
is the read path. Both go through wa-sqlite's async API.

- [ ] **Step 2: Write failing tests for the counter**

Open `src/db/__tests__/Database.spec.ts`. Add a `describe('mutationCounter', …)`
block at the bottom of the file (do not modify existing tests). Insert:

```typescript
describe('mutationCounter', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('starts at 0 on a fresh database', async () => {
    db = new Database()
    await db.init()
    expect(db.mutationCounter).toBe(0)
  })

  it('bumps on INSERT', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const before = db.mutationCounter
    await db.run('INSERT INTO t (id) VALUES (1)')
    expect(db.mutationCounter).toBe(before + 1)
  })

  it('bumps on UPDATE, DELETE, REPLACE', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    await db.run('INSERT INTO t (id, name) VALUES (1, ?)', ['a'])
    const before = db.mutationCounter
    await db.run('UPDATE t SET name = ? WHERE id = 1', ['b'])
    await db.run('DELETE FROM t WHERE id = 1')
    await db.run('REPLACE INTO t (id, name) VALUES (1, ?)', ['c'])
    expect(db.mutationCounter).toBe(before + 3)
  })

  it('bumps on schema changes (CREATE, ALTER, DROP)', async () => {
    db = new Database()
    await db.init()
    const before = db.mutationCounter
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.run('ALTER TABLE t ADD COLUMN name TEXT')
    await db.run('DROP TABLE t')
    expect(db.mutationCounter).toBe(before + 3)
  })

  it('does not bump on exec() reads', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.run('INSERT INTO t (id) VALUES (1)')
    const before = db.mutationCounter
    await db.exec('SELECT * FROM t')
    await db.exec<{ c: number }>('SELECT COUNT(*) AS c FROM t')
    expect(db.mutationCounter).toBe(before)
  })

  it('is case-insensitive on the leading keyword', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const before = db.mutationCounter
    await db.run('  insert  into t (id) values (1)')
    expect(db.mutationCounter).toBe(before + 1)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/db/__tests__/Database.spec.ts -t mutationCounter`
Expected: 6 tests FAIL — `db.mutationCounter` is undefined.

- [ ] **Step 4: Implement `mutationCounter`**

Edit `src/db/Database.ts`:

Add the field declaration to the `Database` class (next to other instance fields,
typically near the top of the class body):

```typescript
/** Monotonic counter bumped by every write through run(). Used by
 *  hashDatabase() to short-circuit re-hashing when nothing has changed.
 *  Reads (exec) do not bump. */
mutationCounter = 0
```

In `run()`, before (or after — pick whichever is cleaner given the existing structure)
the actual wa-sqlite call, insert:

```typescript
// Bump the mutation counter for write keywords. The check is intentionally
// cheap — we look only at the first word, case-insensitive. Statements
// without one of these leading keywords are reads (or no-ops like PRAGMA
// reads) and do not invalidate cached hashes.
const leading = sql.trimStart().slice(0, 8).toUpperCase()
if (
  leading.startsWith('INSERT') ||
  leading.startsWith('UPDATE') ||
  leading.startsWith('DELETE') ||
  leading.startsWith('REPLACE') ||
  leading.startsWith('ALTER') ||
  leading.startsWith('CREATE') ||
  leading.startsWith('DROP')
) {
  this.mutationCounter++
}
```

Confirm the bump happens for the SQL the caller passed, not for any internal SQL
wa-sqlite issues on its own behalf.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/db/__tests__/Database.spec.ts -t mutationCounter`
Expected: 6 tests PASS.

Run the whole `Database` spec: `npx vitest run src/db/__tests__/Database.spec.ts`
Expected: all tests PASS — nothing else broke.

- [ ] **Step 6: Commit**

```bash
git add src/db/Database.ts src/db/__tests__/Database.spec.ts
git commit -m "$(cat <<'EOF'
Add mutationCounter to Database for hash-cache invalidation

A monotonic counter bumped by run() for write statements (INSERT, UPDATE,
DELETE, REPLACE, ALTER, CREATE, DROP). Reads (exec) leave it alone. This
becomes the cache key for the upcoming shared hashDatabase() helper, so
that calling hashDatabase twice with no intervening write returns the
cached value instead of re-walking every row.

The keyword check is a cheap leading-token compare, intentionally not a
full SQL parse — the worst case is over-invalidation (a leading SELECT
that we somehow mis-classify), which costs one extra hash, never silent
staleness.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared `hashDatabase` with WeakMap cache

**Files:**
- Create: `src/sync/hashDatabase.ts`
- Test: `src/sync/__tests__/hashDatabase.spec.ts`

Provider-independent content hash. Walks `SYNC_TABLES` in order, sorts each table's
rows by PK, emits canonical JSON per row, accumulates a SHA-256. Cached per-`Database`
via a module-level `WeakMap` keyed on the `Database` instance.

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/hashDatabase.spec.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { hashDatabase, __resetHashCache } from '../hashDatabase'
import { newId } from '../../db/uuid'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

describe('hashDatabase', () => {
  let dbs: Database[] = []

  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
    __resetHashCache()
  })

  it('returns a sha256:<hex> string', async () => {
    const db = await migratedDb()
    dbs.push(db)
    const h = await hashDatabase(db)
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('returns the same hash for two empty migrated databases', async () => {
    const a = await migratedDb()
    const b = await migratedDb()
    dbs.push(a, b)
    expect(await hashDatabase(a)).toBe(await hashDatabase(b))
  })

  it('returns a different hash after a write', async () => {
    const db = await migratedDb()
    dbs.push(db)
    const before = await hashDatabase(db)
    await db.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Home', '[]', ?, ?)`,
      [newId(), '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'],
    )
    const after = await hashDatabase(db)
    expect(after).not.toBe(before)
  })

  it('is order-independent within a table (same rows inserted in different orders → same hash)', async () => {
    const a = await migratedDb()
    const b = await migratedDb()
    dbs.push(a, b)
    const id1 = '0193fffffffffffffffffffffffffff1'  // smaller PK
    const id2 = '0194000000000000000000000000a002'  // larger PK
    // Insert in order id1, id2 into `a`; id2, id1 into `b`. ORDER BY pk
    // in hashDatabase should yield the same sequence either way.
    await a.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'One', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [id1],
    )
    await a.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Two', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [id2],
    )
    await b.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Two', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [id2],
    )
    await b.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'One', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [id1],
    )
    expect(await hashDatabase(a)).toBe(await hashDatabase(b))
  })

  it('caches by mutationCounter and does not re-walk on a no-write call', async () => {
    const db = await migratedDb()
    dbs.push(db)
    // First call populates the cache.
    const first = await hashDatabase(db)
    // Spy on db.exec to detect a re-walk on the second call.
    const execSpy = vi.spyOn(db, 'exec')
    const second = await hashDatabase(db)
    expect(second).toBe(first)
    expect(execSpy).not.toHaveBeenCalled()
    execSpy.mockRestore()
  })

  it('invalidates the cache when mutationCounter advances', async () => {
    const db = await migratedDb()
    dbs.push(db)
    const before = await hashDatabase(db)
    await db.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'X', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      [newId()],
    )
    const after = await hashDatabase(db)
    expect(after).not.toBe(before)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/hashDatabase.spec.ts`
Expected: FAIL — cannot resolve `../hashDatabase`.

- [ ] **Step 3: Implement `hashDatabase`**

Create `src/sync/hashDatabase.ts`:

```typescript
import type { Database } from '../db/Database'
import { SYNC_TABLES } from './syncTables'
import type { SyncRow } from './types'

// Provider-independent content hash of a Database.
//
// Walks SYNC_TABLES in declared order. For each table, reads every row sorted
// by primary key, emits a canonical JSON line per row (keys sorted
// alphabetically, no whitespace), and accumulates into a SHA-256.
//
// "Content-based" is load-bearing: the hash is over the rows, not over a
// storage form (CSV bytes, .sqlite bytes). Two backends that have synced
// the same logical database produce the same hash, so switching providers
// does not invalidate `lastKnownRemoteState.hash`.
//
// Cached per-Database via a module-level WeakMap keyed on the Database
// instance. The cache key is the Database's mutationCounter — if the
// counter has not advanced since the cached entry, the cached hash is
// returned without re-walking any rows. The WeakMap lets a closed Database
// be garbage-collected with its cache entry.

interface CacheEntry {
  hash: string
  atMutation: number
}

const cache = new WeakMap<Database, CacheEntry>()

/** Test-only: clears the cache. Production code never calls this. */
export function __resetHashCache(): void {
  // WeakMap has no clear(); allocate a fresh one. Cheap and correct.
  ;(cache as unknown as { __wm: WeakMap<Database, CacheEntry> }).__wm = new WeakMap()
}

export async function hashDatabase(db: Database): Promise<string> {
  const cached = cache.get(db)
  if (cached && cached.atMutation === db.mutationCounter) {
    return cached.hash
  }

  // crypto.subtle.digest works on the assembled byte buffer. For a small
  // personal-finance DB this fits comfortably in memory; if we ever push
  // past ~50MB of row text we'd switch to a streaming SHA-256 (an
  // off-the-shelf one — Web Crypto does not stream).
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []

  for (const table of SYNC_TABLES) {
    const rows = await db.exec<SyncRow>(`SELECT * FROM ${table.name} ORDER BY ${table.pk}`)
    for (const row of rows) {
      // Canonical JSON: keys sorted alphabetically, no whitespace, undefined
      // omitted, NULL preserved. JSON.stringify already omits undefined and
      // preserves null; we add explicit key sorting.
      const sortedKeys = Object.keys(row).sort()
      const canonical = JSON.stringify(row, sortedKeys)
      chunks.push(encoder.encode(`${table.name} ${canonical}\n`))
    }
  }

  // Concatenate into one buffer for crypto.subtle.digest.
  const totalLen = chunks.reduce((s, c) => s + c.length, 0)
  const buffer = new Uint8Array(totalLen)
  let offset = 0
  for (const c of chunks) {
    buffer.set(c, offset)
    offset += c.length
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  const result = `sha256:${hex}`

  cache.set(db, { hash: result, atMutation: db.mutationCounter })
  return result
}
```

NOTE: the `__resetHashCache` shape above is a placeholder; the test imports it but
WeakMap can't be cleared in-place. Use this implementation instead — it preserves
the import while actually resetting:

```typescript
// At the top:
let cache = new WeakMap<Database, CacheEntry>()

export function __resetHashCache(): void {
  cache = new WeakMap()
}
```

Replace the `const cache = new WeakMap<…>` line with `let cache = new WeakMap<…>` and
make `__resetHashCache` assign a fresh map.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/hashDatabase.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/hashDatabase.ts src/sync/__tests__/hashDatabase.spec.ts
git commit -m "$(cat <<'EOF'
Add shared content-based hashDatabase with per-Database cache

Provider-independent content hash: walks SYNC_TABLES in declared order,
sorts each table's rows by primary key, emits canonical JSON per row,
SHA-256 of the concatenation. Same logical rows → same hash regardless
of which backend stores them, so switching providers does not trigger a
spurious re-merge.

Cached per Database via a module-level WeakMap keyed on the Database
instance, with mutationCounter as the cache key. A second call with no
intervening write returns the cached hash without re-walking rows;
verified by a vi.spyOn on db.exec.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `syncColumns` per-table column type descriptors

**Files:**
- Create: `src/sync/syncColumns.ts`
- Test: `src/sync/__tests__/syncColumns.spec.ts`

Per-table column descriptors that drive the CSV codec's bulk-import `SELECT` list
(deciding when to `CAST(... AS INTEGER)` vs. `nullif(..., '')` vs. raw `json_extract`).
Sits next to `SYNC_TABLES`. Mechanical — one descriptor per column of each domain
table, matching the schema in `002_domain_schema.ts`.

- [ ] **Step 1: Read the domain schema migration**

Read `src/db/migrations/002_domain_schema.ts` to confirm the exact column lists,
types, and NOT NULL constraints for each of the six domain tables. The descriptors
below must agree with this file. If anything diverges, the test in step 4 will
catch it.

- [ ] **Step 2: Write the failing test**

Create `src/sync/__tests__/syncColumns.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { SYNC_COLUMNS, type ColumnDescriptor } from '../syncColumns'
import { SYNC_TABLES } from '../syncTables'

interface PragmaRow {
  cid: number
  name: string
  type: string
  notnull: 0 | 1
  dflt_value: string | null
  pk: 0 | 1
}

describe('SYNC_COLUMNS', () => {
  it('declares descriptors for every domain table in SYNC_TABLES', () => {
    for (const table of SYNC_TABLES) {
      expect(SYNC_COLUMNS[table.name], `missing descriptor for ${table.name}`).toBeDefined()
      expect(SYNC_COLUMNS[table.name]!.length).toBeGreaterThan(0)
    }
  })

  it('describes each domain table exactly as the schema declares it', async () => {
    const db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    try {
      for (const table of SYNC_TABLES) {
        const declared = SYNC_COLUMNS[table.name]!
        const pragma = await db.exec<PragmaRow>(`PRAGMA table_info(${table.name})`)

        // Names + order match exactly.
        expect(declared.map((c) => c.name), `column order mismatch on ${table.name}`).toEqual(
          pragma.map((r) => r.name),
        )

        // Type affinity matches.
        for (let i = 0; i < declared.length; i++) {
          const d = declared[i]!
          const p = pragma[i]!
          const affinity = affinityOf(p.type)
          expect(d.sqlType, `${table.name}.${d.name} sqlType`).toBe(affinity)
          expect(d.nullable, `${table.name}.${d.name} nullable`).toBe(p.notnull === 0)
        }
      }
    } finally {
      await db.close()
    }
  })
})

function affinityOf(declared: string): ColumnDescriptor['sqlType'] {
  // Per CLAUDE.md, the project pins declared types to TEXT / INTEGER / REAL.
  // Anything else is a bug in either the schema or the descriptor.
  const t = declared.toUpperCase()
  if (t === 'TEXT') return 'TEXT'
  if (t === 'INTEGER') return 'INTEGER'
  if (t === 'REAL') return 'REAL'
  throw new Error(`unexpected column type "${declared}" — project uses only TEXT/INTEGER/REAL`)
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/syncColumns.spec.ts`
Expected: FAIL — cannot resolve `../syncColumns`.

- [ ] **Step 4: Implement `syncColumns`**

Create `src/sync/syncColumns.ts`:

```typescript
// Per-table column type descriptors used by csvCodec's bulk-import path.
//
// For each table in SYNC_TABLES, lists the columns in CREATE-TABLE order
// with their SQLite affinity and nullability. The CSV import builds a
// SELECT list from this descriptor:
//
//   INTEGER     → CAST(json_extract(value, '$.col') AS INTEGER)
//   REAL        → CAST(json_extract(value, '$.col') AS REAL)
//   TEXT + null → nullif(json_extract(value, '$.col'), '')
//   TEXT + !null→ json_extract(value, '$.col')
//
// The match against PRAGMA table_info is enforced by syncColumns.spec.ts —
// changing the schema and forgetting to update this file fails CI.

export interface ColumnDescriptor {
  name: string
  sqlType: 'TEXT' | 'INTEGER' | 'REAL'
  nullable: boolean
}

export const SYNC_COLUMNS: Record<string, ColumnDescriptor[]> = {
  // FILL IN: read src/db/migrations/002_domain_schema.ts and translate each
  // CREATE TABLE statement into a descriptor array, preserving column order.
  // For each column:
  //   - name: the column name from CREATE TABLE
  //   - sqlType: the declared type (must be TEXT, INTEGER, or REAL — the
  //     project's SQLite conventions in CLAUDE.md pin these three)
  //   - nullable: true if the column is NOT marked NOT NULL
  //
  // The six tables to cover (in SYNC_TABLES order):
  //   locations, tags, exchange_rates, account_groupings, accounts, transactions
  //
  // Example for the locations table (verify against the migration; this is
  // illustrative, not authoritative):
  //
  // locations: [
  //   { name: 'id',              sqlType: 'TEXT',    nullable: false },
  //   { name: 'name',            sqlType: 'TEXT',    nullable: false },
  //   { name: 'description',     sqlType: 'TEXT',    nullable: true  },
  //   { name: 'address',         sqlType: 'TEXT',    nullable: true  },
  //   { name: 'city',            sqlType: 'TEXT',    nullable: true  },
  //   { name: 'country',         sqlType: 'TEXT',    nullable: true  },
  //   { name: 'latitude',        sqlType: 'REAL',    nullable: true  },
  //   { name: 'longitude',       sqlType: 'REAL',    nullable: true  },
  //   { name: 'tags',            sqlType: 'TEXT',    nullable: false },
  //   { name: 'created_at_utc',  sqlType: 'TEXT',    nullable: false },
  //   { name: 'updated_at_utc',  sqlType: 'TEXT',    nullable: false },
  //   { name: 'deleted_at_utc',  sqlType: 'TEXT',    nullable: true  },
  // ],
}
```

NOTE: the test (step 2) is intentionally self-validating against `PRAGMA
table_info`, so the agent fills the descriptor by reading the migration and the
test confirms correctness. If the descriptor is wrong, the test points at the
exact `${table}.${column}` mismatch.

- [ ] **Step 5: Run the test, iterating until it passes**

Run: `npx vitest run src/sync/__tests__/syncColumns.spec.ts`

If the test reports a mismatch, edit `SYNC_COLUMNS[<table>]` to match. The
expected end state is six tables fully described.

Expected when correct: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/sync/syncColumns.ts src/sync/__tests__/syncColumns.spec.ts
git commit -m "$(cat <<'EOF'
Add per-table column type descriptors for CSV codec

SYNC_COLUMNS maps each domain table name to an ordered list of
{ name, sqlType, nullable } descriptors that csvCodec will use to build
its bulk INSERT … SELECT json_extract(…) FROM json_each(?) statement.
INTEGER and REAL columns need CAST; nullable TEXT columns need nullif on
the empty string; non-nullable TEXT passes through.

The descriptor is self-validating: a test compares it against
PRAGMA table_info for each table, so changing the schema without
updating the descriptor fails fast at exactly the column that drifted.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Install PapaParse and aws4fetch dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`

Add the two runtime dependencies the upcoming tasks need. Keeping this as its own
task so the dependency bump is its own commit, separable from the code that uses it.

- [ ] **Step 1: Install the dependencies**

Run:

```bash
npm install papaparse aws4fetch
npm install --save-dev @types/papaparse
```

- [ ] **Step 2: Confirm the package.json shape**

Read `package.json`. The `dependencies` section should now contain:
- `papaparse` (a recent 5.x; PapaParse is stable, any 5.x works).
- `aws4fetch` (a recent 1.x).

The `devDependencies` section should now contain `@types/papaparse`.

- [ ] **Step 3: Verify the install**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors. (We haven't imported either library yet, so this just confirms
the install didn't break the existing TypeScript config.)

Run: `npm run test:unit`
Expected: PASS (sanity — no regressions from the install).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
Add PapaParse and aws4fetch for the sync backends

PapaParse: CSV ↔ object-array round-trip for the GitHubCsvBackend codec.
RFC 4180-compliant quoting, embedded newlines, JSON-literal cells —
chosen so the codec does not re-implement string-escape edge cases.

aws4fetch: minimal AWS Signature v4 implementation for the
S3-compatible transport. Small, well-tested, no AWS SDK bundle.

@types/papaparse: TypeScript types. PapaParse ships JS only.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `SyncBackend` interface + refactor orchestrator and seams

**Files:**
- Create: `src/sync/SyncBackend.ts`
- Delete: `src/sync/SyncProvider.ts`, `src/sync/DatabaseCodec.ts`
- Modify: `src/sync/syncOrchestrator.ts`
- Modify: `src/sync/__tests__/fakes.ts`, `src/sync/__tests__/fakes.spec.ts`
- Modify: `src/sync/__tests__/syncOrchestrator.spec.ts`
- Modify: `src/db/init.ts`
- Modify: `src/views/useSyncSettings.ts`, `src/views/__tests__/useSyncSettings.spec.ts`

The big refactor. `SyncProvider` + `DatabaseCodec` collapse into one `SyncBackend`
that exposes Database-level operations. The orchestrator and the Settings composable
update to the new shape. The 49 already-passing orchestrator tests must still pass —
their assertions don't change, only the `deps` factory and the fake do.

This is one task with many steps because the pieces must land together: the old
interfaces being deleted breaks every consumer in one go.

- [ ] **Step 1: Create `SyncBackend.ts`**

Create `src/sync/SyncBackend.ts`:

```typescript
import type { Database } from '../db/Database'
import type { SyncMetadata } from './types'

/**
 * The single seam between the sync orchestrator and the world. One concrete
 * backend per provider:
 *   - GitHubCsvBackend stores CSV-per-table inside a git repo.
 *   - SqliteBlobBackend stores a single .sqlite blob plus a metadata sidecar
 *     (used by Supabase Storage and S3-compatible transports).
 *
 * Whether the backend stores one file or many is its private detail. The
 * orchestrator only sees Database-level operations.
 *
 * Contract notes:
 *  - getMetadata() may have a side effect: caches whatever CAS handle the
 *    next tryUpload() needs (e.g., the current branch HEAD commit SHA for
 *    GitHub, the metadata sidecar's ETag for S3).
 *  - tryUpload() requires a prior getMetadata() — calling it cold is a
 *    programming error and the backend should throw.
 *  - downloadDatabase() returns a freshly-opened in-memory Database. The
 *    caller owns the lifecycle and closes it after use.
 *  - hashDatabase(db) is provider-independent (delegates to the shared
 *    hashDatabase function). It is on the interface only so test code can
 *    use whatever backend it has without reaching into the helper module.
 */
export interface SyncBackend {
  /** Current remote metadata, or null when nothing has ever been uploaded. */
  getMetadata(): Promise<SyncMetadata | null>

  /** Downloads the remote database into a fresh in-memory Database. Caller closes it. */
  downloadDatabase(): Promise<Database>

  /** Content hash of `db` — same logical DB yields the same hash across backends. */
  hashDatabase(db: Database): Promise<string>

  /**
   * CAS upload. Exports `localDb` and writes it; succeeds only if the
   * current remote metadata still equals `expected` (both null for the
   * first upload). Returns false on CAS miss — the orchestrator then re-
   * merges. Throws if called without a prior getMetadata().
   */
  tryUpload(
    localDb: Database,
    metadata: SyncMetadata,
    expected: SyncMetadata | null,
  ): Promise<boolean>
}

/** True when two metadata values are equal for the purpose of the CAS check. */
export function metadataEquals(a: SyncMetadata | null, b: SyncMetadata | null): boolean {
  if (a === null || b === null) return a === b
  return a.device === b.device && a.uploadedAtUtc === b.uploadedAtUtc && a.hash === b.hash
}
```

`metadataEquals` is carried over from the old `SyncProvider.ts` — preserve its
behaviour exactly so anything that imported it from the old path keeps working.

- [ ] **Step 2: Replace the `fakes.ts` test helper**

Read the current `src/sync/__tests__/fakes.ts` first to see the shape of
`FakeSyncProvider` and `FakeDatabaseCodec`. Then replace the entire file with:

```typescript
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { hashDatabase } from '../hashDatabase'
import type { SyncBackend } from '../SyncBackend'
import type { SyncMetadata } from '../types'

/**
 * In-memory SyncBackend for unit tests. Holds an open Database directly as
 * the "remote state" — no codec round-trip needed, no transport simulated.
 * The tests that exercise the real CSV and blob codecs live in their own
 * spec files; this fake is exclusively for the orchestrator suite.
 */
export class FakeSyncBackend implements SyncBackend {
  private remoteDb: Database | null = null
  private remoteMeta: SyncMetadata | null = null
  /** Stub for the CAS handle the real backends cache from getMetadata(). */
  private metadataReadAt: SyncMetadata | null = null

  /** Test hook: simulate the remote being updated by some other writer. */
  async setRemote(db: Database, meta: SyncMetadata): Promise<void> {
    if (this.remoteDb) await this.remoteDb.close()
    this.remoteDb = db
    this.remoteMeta = meta
  }

  async getMetadata(): Promise<SyncMetadata | null> {
    this.metadataReadAt = this.remoteMeta
    return this.remoteMeta
  }

  async downloadDatabase(): Promise<Database> {
    if (!this.remoteDb) throw new Error('FakeSyncBackend: no remote database')
    // Return a *clone* so the orchestrator's mutations don't leak back into
    // the simulated remote. The cheapest correct clone is: export every row
    // into a fresh migrated DB.
    const clone = new Database()
    await clone.init()
    await runMigrations(clone, [settingsMigration, domainMigration])
    // Copy rows in FK order via the merge engine's helpers. For test
    // simplicity, just re-import via a direct SELECT/INSERT loop per table.
    const { SYNC_TABLES } = await import('../syncTables')
    for (const t of SYNC_TABLES) {
      const rows = await this.remoteDb.exec<Record<string, unknown>>(`SELECT * FROM ${t.name}`)
      for (const row of rows) {
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        await clone.run(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${placeholders})`,
          cols.map((c) => row[c]),
        )
      }
    }
    return clone
  }

  async hashDatabase(db: Database): Promise<string> {
    return hashDatabase(db)
  }

  async tryUpload(
    localDb: Database,
    metadata: SyncMetadata,
    expected: SyncMetadata | null,
  ): Promise<boolean> {
    if (this.metadataReadAt === null && expected !== null) {
      // The orchestrator must have called getMetadata() first.
      throw new Error('FakeSyncBackend.tryUpload called without prior getMetadata')
    }
    // CAS check: current remote must still equal what the caller saw.
    const currentEquals =
      (this.remoteMeta === null && expected === null) ||
      (this.remoteMeta !== null &&
        expected !== null &&
        this.remoteMeta.device === expected.device &&
        this.remoteMeta.uploadedAtUtc === expected.uploadedAtUtc &&
        this.remoteMeta.hash === expected.hash)
    if (!currentEquals) return false

    // Accept the upload: clone localDb into the remote slot the same way
    // downloadDatabase does, so the next download returns a fresh clone too.
    const clone = new Database()
    await clone.init()
    await runMigrations(clone, [settingsMigration, domainMigration])
    const { SYNC_TABLES } = await import('../syncTables')
    for (const t of SYNC_TABLES) {
      const rows = await localDb.exec<Record<string, unknown>>(`SELECT * FROM ${t.name}`)
      for (const row of rows) {
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        await clone.run(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${placeholders})`,
          cols.map((c) => row[c]),
        )
      }
    }
    if (this.remoteDb) await this.remoteDb.close()
    this.remoteDb = clone
    this.remoteMeta = metadata
    return true
  }

  /** Test hook: introspect the simulated remote without going through download. */
  peekMeta(): SyncMetadata | null {
    return this.remoteMeta
  }

  async close(): Promise<void> {
    if (this.remoteDb) await this.remoteDb.close()
    this.remoteDb = null
    this.remoteMeta = null
  }
}
```

- [ ] **Step 3: Update `fakes.spec.ts` to test `FakeSyncBackend`**

Read the existing `fakes.spec.ts`. Replace the tests for `FakeSyncProvider` and
`FakeDatabaseCodec` with tests covering `FakeSyncBackend`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { FakeSyncBackend } from './fakes'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import type { SyncMetadata } from '../types'

const META = (over: Partial<SyncMetadata> = {}): SyncMetadata => ({
  device: 'dev-A',
  uploadedAtUtc: '2026-05-22T10:00:00.000Z',
  hash: 'sha256:h1',
  migrationVersion: 2,
  ...over,
})

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

describe('FakeSyncBackend', () => {
  let backend: FakeSyncBackend
  let cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    await backend?.close()
    for (const c of cleanups) await c()
    cleanups = []
  })

  it('starts empty', async () => {
    backend = new FakeSyncBackend()
    expect(await backend.getMetadata()).toBeNull()
  })

  it('accepts a first-sync upload (expected === null)', async () => {
    backend = new FakeSyncBackend()
    const local = await migratedDb()
    cleanups.push(() => local.close())

    await backend.getMetadata()
    const ok = await backend.tryUpload(local, META(), null)
    expect(ok).toBe(true)
    expect(await backend.getMetadata()).toEqual(META())
  })

  it('rejects a CAS miss (expected does not match current remote)', async () => {
    backend = new FakeSyncBackend()
    const local = await migratedDb()
    cleanups.push(() => local.close())
    // Pre-seed the remote with a different metadata.
    const seedDb = await migratedDb()
    await backend.setRemote(seedDb, META({ hash: 'sha256:other' }))

    await backend.getMetadata()
    const ok = await backend.tryUpload(local, META(), null) // expected null, but remote isn't
    expect(ok).toBe(false)
  })

  it('downloadDatabase returns a fresh clone that the caller can mutate safely', async () => {
    backend = new FakeSyncBackend()
    const seed = await migratedDb()
    await seed.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'X', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      ['loc-1'],
    )
    await backend.setRemote(seed, META())

    const downloaded = await backend.downloadDatabase()
    cleanups.push(() => downloaded.close())
    // Mutate the clone — must not affect the simulated remote.
    await downloaded.run('DELETE FROM locations WHERE id = ?', ['loc-1'])

    const downloadedAgain = await backend.downloadDatabase()
    cleanups.push(() => downloadedAgain.close())
    const rows = await downloadedAgain.exec('SELECT * FROM locations')
    expect(rows).toHaveLength(1)
  })

  it('throws when tryUpload is called without a prior getMetadata and remote is not empty', async () => {
    backend = new FakeSyncBackend()
    const seed = await migratedDb()
    await backend.setRemote(seed, META())
    const local = await migratedDb()
    cleanups.push(() => local.close())

    await expect(backend.tryUpload(local, META(), META())).rejects.toThrow(/prior getMetadata/)
  })
})
```

- [ ] **Step 4: Update `syncOrchestrator.ts`**

Read `src/sync/syncOrchestrator.ts`. It currently imports from `SyncProvider` and
`DatabaseCodec` and has a `SyncDeps` interface with `provider` and `codec` fields.
Replace the imports and the `SyncDeps` declaration:

```typescript
import type { SyncBackend } from './SyncBackend'
```

Replace the existing `SyncDeps` (the field set, not the surrounding context):

```typescript
/** Everything `runSync` needs, injected so the orchestrator stays testable. */
export interface SyncDeps {
  backend: SyncBackend
  /** This device's identity, carried through to other devices in SyncMetadata.device. */
  deviceName: string
  /** Current time — injectable so tests are deterministic. */
  now: () => Date
  /** Brings a downloaded older-schema database up to the current schema. */
  migrate: (db: Database) => Promise<void>
  loadLastKnown: () => RemoteState | null
  saveLastKnown: (state: RemoteState) => void
}
```

Rewrite `runSync` (the body — keep the function signature) to use the new API. The
key transformations:

- `await deps.provider.getMetadata()` → `await deps.backend.getMetadata()`
- `const remoteBlob = await deps.provider.download()` → drop this line entirely
- `const remoteDb = await deps.codec.openFromBlob(remoteBlob)` →
  `const remoteDb = await deps.backend.downloadDatabase()`
- `const localHash = await deps.codec.hash(await deps.codec.export(localDb))` →
  `const localHash = await deps.backend.hashDatabase(localDb)`
- The final CAS upload becomes:
  ```typescript
  const finalHash = await deps.backend.hashDatabase(localDb)
  const stamp: SyncMetadata = {
    device: deps.deviceName,
    uploadedAtUtc: deps.now().toISOString(),
    hash: finalHash,
    migrationVersion: await readSchemaVersion(localDb),
  }
  const uploaded = await deps.backend.tryUpload(localDb, stamp, expected)
  ```

The control flow (scenario 1 short-circuit, scenario 2.1 upload-local with
re-getMetadata retry, scenario 2.2 merge-and-CAS loop, schema gate) is unchanged.

- [ ] **Step 5: Update `syncOrchestrator.spec.ts`**

Open `src/sync/__tests__/syncOrchestrator.spec.ts`. Find the `deps` factory near the
top of the file (or wherever it's defined). Replace it with:

```typescript
function deps(backend: FakeSyncBackend) {
  const state: { lastKnown: import('../types').RemoteState | null } = { lastKnown: null }
  return {
    backend,
    deviceName: 'dev-A',
    now: () => new Date('2026-05-22T12:00:00.000Z'),
    migrate: async () => {},
    loadLastKnown: () => state.lastKnown,
    saveLastKnown: (s: import('../types').RemoteState) => {
      state.lastKnown = s
    },
  }
}
```

Update the import at the top of the file: `FakeSyncProvider, FakeDatabaseCodec` →
`FakeSyncBackend`. Replace every `new FakeSyncProvider()` / `new FakeDatabaseCodec()`
construction with `new FakeSyncBackend()`. Where tests previously did
`provider.upload(...)` or `provider.setMetadata(...)` to set up state, switch to
`backend.setRemote(seedDb, meta)`.

The assertions stay as-is. Every test must still pass.

- [ ] **Step 6: Update `init.ts`**

Open `src/db/init.ts`. Replace `setDatabaseCodec` / `getDatabaseCodec` with
`setSyncBackend` / `getSyncBackend`:

```typescript
import type { SyncBackend } from '../sync/SyncBackend'

let syncBackend: SyncBackend | null = null

export function setSyncBackend(backend: SyncBackend | null): void {
  syncBackend = backend
}

export function getSyncBackend(): SyncBackend | null {
  return syncBackend
}
```

Remove the old `databaseCodec` slot and its accessors. In `closeDatabase`, replace
`databaseCodec = null` with `syncBackend = null`.

Remove the `import type { DatabaseCodec } from '../sync/DatabaseCodec'` line.

- [ ] **Step 7: Update `useSyncSettings.ts`**

Open `src/views/useSyncSettings.ts`. The composable currently takes `{ db, codec }`.
Change it to `{ db, backend }` and replace the codec-based local hash computation
with `backend.hashDatabase(db)`:

```typescript
import type { SyncBackend } from '@/sync/SyncBackend'

export interface SyncSettingsDeps {
  db: Database | null
  backend: SyncBackend | null
}

// In the implementation:
async function recomputeLocalHash(): Promise<void> {
  if (!deps.db || !deps.backend) {
    localHash.value = null
    localHashComputedAt.value = null
    return
  }
  localHash.value = await deps.backend.hashDatabase(deps.db)
  localHashComputedAt.value = new Date()
}
```

Remove the `codec` import. Remove the `codec.export()`/`codec.hash()` chain.

- [ ] **Step 8: Update `useSyncSettings.spec.ts`**

The existing test fakes a `DatabaseCodec`. Replace those with a minimal
`FakeSyncBackend`-shaped stub:

```typescript
import type { SyncBackend } from '../../sync/SyncBackend'

function fakeBackend(hash: string): SyncBackend {
  return {
    getMetadata: async () => null,
    downloadDatabase: async () => { throw new Error('not used here') },
    hashDatabase: async () => hash,
    tryUpload: async () => true,
  }
}
```

Replace every `codec:` field in test deps with `backend:`. Replace the
`db: fakeDb, codec: null` form with `db: fakeDb, backend: null`. The assertions
stay as-is.

- [ ] **Step 9: Delete the old interface files**

Run:

```bash
git rm src/sync/SyncProvider.ts src/sync/DatabaseCodec.ts
```

- [ ] **Step 10: Verify nothing imports the deleted symbols**

Search the repo for any remaining references:

Run: `npx grep -rn "DatabaseCodec\|SyncProvider\|FakeSyncProvider\|FakeDatabaseCodec\|setDatabaseCodec\|getDatabaseCodec" src/`

Expected: no matches. If any appear, update them — they are either in code that was
missed or in stale comments. Comments can be edited in place.

(On Windows PowerShell: `Select-String -Path src\* -Pattern 'DatabaseCodec|SyncProvider' -Recurse`.)

- [ ] **Step 11: Type-check and run the whole test suite**

Run: `npm run type-check`
Expected: zero errors.

Run: `npm run test:unit`
Expected: every existing test still passes — including all 49 in
`syncOrchestrator.spec.ts`. If any assertion fails, the refactor is wrong;
fix the refactor, not the test.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Collapse SyncProvider + DatabaseCodec into one SyncBackend interface

Replaces the two-interface seam (network provider + serialisation codec)
with a single SyncBackend that returns open Databases. The orchestrator
no longer knows whether the remote is one blob or many CSV files; that
becomes the backend's private detail.

Mechanical surface changes:

- src/sync/SyncBackend.ts (new) declares the unified interface plus the
  preserved metadataEquals helper.
- src/sync/SyncProvider.ts and src/sync/DatabaseCodec.ts deleted.
- syncOrchestrator's SyncDeps swaps provider + codec for backend; runSync
  body uses backend.downloadDatabase() and backend.hashDatabase()
  directly. The scenario logic in decideSync is unchanged.
- FakeSyncBackend (in __tests__/fakes.ts) consolidates FakeSyncProvider
  and FakeDatabaseCodec. It holds an open Database directly as the
  simulated remote and clones it on download/upload so test mutations
  don't leak.
- syncOrchestrator.spec.ts deps factory takes a FakeSyncBackend; all 49
  assertions still pass unchanged.
- init.ts: setDatabaseCodec/getDatabaseCodec → setSyncBackend/
  getSyncBackend.
- useSyncSettings + its spec take a backend instead of a codec; the local
  hash computation becomes backend.hashDatabase(db) — simpler.

The 49 orchestrator tests held throughout, confirming the refactor
preserves every algorithm branch.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `csvCodec` — CSV ↔ Database

**Files:**
- Create: `src/sync/csvCodec.ts`
- Test: `src/sync/__tests__/csvCodec.spec.ts`

PapaParse for CSV ↔ object array. One bulk `INSERT … SELECT json_extract(…) FROM
json_each(?)` per table for import — one Asyncify yield-point per table instead of
one per row. Forward-compat: unknown CSV columns are caught by the schema gate
(the codec never sees a remote newer than this app), missing CSV columns become
NULL via `json_extract`.

- [ ] **Step 1: Write the failing tests**

Create `src/sync/__tests__/csvCodec.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import {
  exportTableToCsv,
  importCsvIntoTable,
  exportAllTables,
  importAllTables,
} from '../csvCodec'
import { SYNC_TABLES } from '../syncTables'
import { rowsEqual } from '../rows'
import { newId } from '../../db/uuid'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

const CUTOFF = '2026-05-01T00:00:00.000Z'

describe('csvCodec', () => {
  let dbs: Database[] = []

  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
  })

  describe('exportTableToCsv', () => {
    it('emits a header row followed by sorted-by-PK rows', async () => {
      const db = await migratedDb()
      dbs.push(db)
      const id1 = '0193ffffffffffffffffffffffffff01'
      const id2 = '0194000000000000000000000000a002'
      await db.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'Two', '[]', ?, ?)`,
        [id2, CUTOFF, CUTOFF],
      )
      await db.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'One', '[]', ?, ?)`,
        [id1, CUTOFF, CUTOFF],
      )
      const csv = await exportTableToCsv(db, { name: 'locations', pk: 'id' })
      const lines = csv.split('\n').filter((l) => l.length > 0)
      expect(lines[0]).toMatch(/^id,name,/)
      expect(lines[1]!).toContain(id1)
      expect(lines[2]!).toContain(id2)
    })

    it('quotes commas, double quotes, and embedded newlines per RFC 4180', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await db.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, ?, '[]', ?, ?)`,
        [newId(), 'Smith, "Jr."\nNYC', CUTOFF, CUTOFF],
      )
      const csv = await exportTableToCsv(db, { name: 'locations', pk: 'id' })
      // The Name cell should be quoted; the embedded double quote should
      // be doubled; the embedded newline should sit inside the quoted cell.
      expect(csv).toMatch(/"Smith, ""Jr\.""\nNYC"/)
    })

    it('emits NULL as an empty cell', async () => {
      const db = await migratedDb()
      dbs.push(db)
      await db.run(
        `INSERT INTO locations (id, name, city, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'X', NULL, '[]', ?, ?)`,
        [newId(), CUTOFF, CUTOFF],
      )
      const csv = await exportTableToCsv(db, { name: 'locations', pk: 'id' })
      const dataLine = csv.split('\n')[1]!
      expect(dataLine.split(',').some((c) => c === '')).toBe(true)
    })
  })

  describe('importCsvIntoTable', () => {
    it('round-trips a seeded row exactly', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      const id = newId()
      await src.run(
        `INSERT INTO locations (id, name, city, country, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'Home', 'Berlin', 'DE', '["a","b"]', ?, ?)`,
        [id, CUTOFF, CUTOFF],
      )
      const csv = await exportTableToCsv(src, { name: 'locations', pk: 'id' })
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, csv)
      const srcRows = await src.exec<Record<string, unknown>>('SELECT * FROM locations')
      const dstRows = await dst.exec<Record<string, unknown>>('SELECT * FROM locations')
      expect(dstRows).toHaveLength(srcRows.length)
      expect(rowsEqual(srcRows[0]!, dstRows[0]!)).toBe(true)
    })

    it('coerces INTEGER and REAL columns to numbers (not strings)', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      await src.run(
        `INSERT INTO locations (id, name, latitude, longitude, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'GPS', 52.5, 13.4, '[]', ?, ?)`,
        [newId(), CUTOFF, CUTOFF],
      )
      const csv = await exportTableToCsv(src, { name: 'locations', pk: 'id' })
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, csv)
      const row = (await dst.exec<{ latitude: unknown; longitude: unknown }>(
        'SELECT latitude, longitude FROM locations',
      ))[0]!
      expect(typeof row.latitude).toBe('number')
      expect(row.latitude).toBeCloseTo(52.5)
    })

    it('coerces empty cells in nullable columns to NULL', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      await src.run(
        `INSERT INTO locations (id, name, city, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'X', NULL, '[]', ?, ?)`,
        [newId(), CUTOFF, CUTOFF],
      )
      const csv = await exportTableToCsv(src, { name: 'locations', pk: 'id' })
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, csv)
      const row = (await dst.exec<{ city: unknown }>('SELECT city FROM locations'))[0]!
      expect(row.city).toBeNull()
    })

    it('preserves a JSON-literal cell (tags array)', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      await src.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'X', ?, ?, ?)`,
        [newId(), '["a","b","c"]', CUTOFF, CUTOFF],
      )
      const csv = await exportTableToCsv(src, { name: 'locations', pk: 'id' })
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, csv)
      const row = (await dst.exec<{ tags: string }>('SELECT tags FROM locations'))[0]!
      expect(JSON.parse(row.tags)).toEqual(['a', 'b', 'c'])
    })

    it('imports nothing from an empty CSV (header only)', async () => {
      const dst = await migratedDb()
      dbs.push(dst)
      const headerOnly = await exportTableToCsv(dst, { name: 'locations', pk: 'id' })
      await importCsvIntoTable(dst, { name: 'locations', pk: 'id' }, headerOnly)
      expect(await dst.exec('SELECT * FROM locations')).toHaveLength(0)
    })
  })

  describe('exportAllTables / importAllTables (round-trip)', () => {
    it('round-trips a DB with rows in every table', async () => {
      const src = await migratedDb()
      const dst = await migratedDb()
      dbs.push(src, dst)
      const locId = newId()
      const accId = newId()
      await src.run(
        `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
         VALUES (?, 'Home', '[]', ?, ?)`,
        [locId, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO tags (tag, description, synonyms, created_at_utc, updated_at_utc)
         VALUES (?, NULL, '[]', ?, ?)`,
        ['food', CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, location_id,
                               colour, icon, created_at_utc, updated_at_utc)
         VALUES (?, 'Checking', 'USD', 0, 2, ?, '#000000', 'wallet', ?, ?)`,
        [accId, locId, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO exchange_rates (id, base, target, rates, fetched_at_utc, provider,
                                     created_at_utc, updated_at_utc)
         VALUES (?, 'USD', 'EUR', '{"2026-05-01":0.92}', ?, 'oer', ?, ?)`,
        [newId(), CUTOFF, CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO account_groupings (id, name, accounts_ids, created_at_utc, updated_at_utc)
         VALUES (?, 'Cash', ?, ?, ?)`,
        [newId(), JSON.stringify([accId]), CUTOFF, CUTOFF],
      )
      await src.run(
        `INSERT INTO transactions
           (id, account_id__from, account_id__to,
            amount_value__from, amount_scale__from, amount_currency__from,
            amount_value__to, amount_scale__to, amount_currency__to,
            transaction_at_local, transaction_at_zone,
            created_at_utc, updated_at_utc)
         VALUES (?, ?, NULL, 100, 2, 'USD', 100, 2, 'USD',
                 '2026-05-01T09:00:00.000+00:00', 'UTC', ?, ?)`,
        [newId(), accId, CUTOFF, CUTOFF],
      )
      const bundle = await exportAllTables(src)
      for (const t of SYNC_TABLES) {
        expect(bundle.has(t.name), `bundle missing ${t.name}`).toBe(true)
      }
      await importAllTables(dst, bundle)
      for (const t of SYNC_TABLES) {
        const srcRows = await src.exec<Record<string, unknown>>(
          `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
        )
        const dstRows = await dst.exec<Record<string, unknown>>(
          `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
        )
        expect(dstRows.length, `row count mismatch on ${t.name}`).toBe(srcRows.length)
        for (let i = 0; i < srcRows.length; i++) {
          expect(rowsEqual(srcRows[i]!, dstRows[i]!), `row mismatch on ${t.name}[${i}]`).toBe(true)
        }
      }
    })

    it('rolls back the destination on an FK violation mid-import', async () => {
      const dst = await migratedDb()
      dbs.push(dst)
      const bundle = new Map<string, string>()
      // Empty parents but a transaction referencing a non-existent account.
      // exportTableToCsv on an empty dst gives us header-only CSVs for the
      // tables that aren't transactions.
      for (const t of SYNC_TABLES) {
        bundle.set(t.name, await exportTableToCsv(dst, t))
      }
      const txnHeader = bundle.get('transactions')!
      bundle.set(
        'transactions',
        txnHeader +
          `${newId()},missing-account,,100,2,USD,100,2,USD,2026-05-01T09:00:00.000+00:00,UTC,${CUTOFF},${CUTOFF},\n`,
      )
      await expect(importAllTables(dst, bundle)).rejects.toThrow()
      // Other tables also imported nothing — everything rolled back.
      for (const t of SYNC_TABLES) {
        expect(await dst.exec(`SELECT * FROM ${t.name}`)).toHaveLength(0)
      }
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/csvCodec.spec.ts`
Expected: FAIL — cannot resolve `../csvCodec`.

- [ ] **Step 3: Implement `csvCodec.ts`**

Create `src/sync/csvCodec.ts`:

```typescript
import Papa from 'papaparse'
import type { Database } from '../db/Database'
import { SYNC_COLUMNS, type ColumnDescriptor } from './syncColumns'
import { SYNC_TABLES, type SyncTable } from './syncTables'

// CSV ↔ Database round-trip for GitHubCsvBackend.
//
// Export: SELECT columns FROM <table> ORDER BY <pk> with column order pinned
// by SYNC_COLUMNS; Papa.unparse for RFC 4180 quoting / embedded-newline /
// quote-in-cell escaping. Newline pinned to \n (matches .gitattributes; the
// platform default would produce CRLF on Windows).
//
// Import: Papa.parse with header: true, then one bulk INSERT per table via
// json_each(?). wa-sqlite's Asyncify build penalises every await on the DB
// (each is a stack-unwind yield-point) — per-row parametrised INSERTs would
// be O(rows * roundtrips); the json_each approach is O(tables) roundtrips.
// Coercion lives in the SELECT list per SYNC_COLUMNS:
//   INTEGER   → CAST(json_extract(value, '$.col') AS INTEGER)
//   REAL      → CAST(json_extract(value, '$.col') AS REAL)
//   TEXT null → nullif(json_extract(value, '$.col'), '')
//   TEXT !null→ json_extract(value, '$.col')

export async function exportTableToCsv(db: Database, table: SyncTable): Promise<string> {
  const columns = SYNC_COLUMNS[table.name]
  if (!columns) throw new Error(`csvCodec: no syncColumns descriptor for "${table.name}"`)
  const columnList = columns.map((c) => c.name).join(', ')
  const rows = await db.exec<Record<string, unknown>>(
    `SELECT ${columnList} FROM ${table.name} ORDER BY ${table.pk}`,
  )
  return (
    Papa.unparse(rows, {
      header: true,
      newline: '\n',
      columns: columns.map((c) => c.name),
    }) + '\n'
  )
}

export async function importCsvIntoTable(
  db: Database,
  table: SyncTable,
  csvText: string,
): Promise<void> {
  const columns = SYNC_COLUMNS[table.name]
  if (!columns) throw new Error(`csvCodec: no syncColumns descriptor for "${table.name}"`)

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  if (parsed.errors.length > 0) {
    const e = parsed.errors[0]!
    throw new Error(
      `csvCodec.importCsvIntoTable(${table.name}): CSV parse error at row ${e.row}: ${e.message}`,
    )
  }
  if (parsed.data.length === 0) return

  const columnList = columns.map((c) => c.name).join(', ')
  const selectList = columns.map(selectExpressionFor).join(',\n  ')
  await db.run(
    `INSERT INTO ${table.name} (${columnList})
     SELECT
       ${selectList}
     FROM json_each(?)`,
    [JSON.stringify(parsed.data)],
  )
}

function selectExpressionFor(c: ColumnDescriptor): string {
  const path = `'$.${c.name}'`
  if (c.sqlType === 'INTEGER') return `CAST(json_extract(value, ${path}) AS INTEGER)`
  if (c.sqlType === 'REAL') return `CAST(json_extract(value, ${path}) AS REAL)`
  return c.nullable
    ? `nullif(json_extract(value, ${path}), '')`
    : `json_extract(value, ${path})`
}

/** Export every domain table to a Map<name, csv>. Insertion order matches SYNC_TABLES. */
export async function exportAllTables(db: Database): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const t of SYNC_TABLES) out.set(t.name, await exportTableToCsv(db, t))
  return out
}

/**
 * Import every domain table from a Map<name, csv> in FK order (parents before
 * children, per SYNC_TABLES). Wrapped in a single BEGIN/COMMIT so a mid-
 * import failure (FK violation, malformed CSV, missing entry) rolls back
 * cleanly rather than leaving a partially-populated DB.
 */
export async function importAllTables(db: Database, bundle: Map<string, string>): Promise<void> {
  await db.run('BEGIN')
  try {
    for (const t of SYNC_TABLES) {
      const csv = bundle.get(t.name)
      if (csv === undefined) {
        throw new Error(`csvCodec.importAllTables: missing CSV for "${t.name}"`)
      }
      await importCsvIntoTable(db, t, csv)
    }
    await db.run('COMMIT')
  } catch (e) {
    await db.run('ROLLBACK')
    throw e
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/csvCodec.spec.ts`
Expected: PASS — ~10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/csvCodec.ts src/sync/__tests__/csvCodec.spec.ts
git commit -m "Add csvCodec for GitHubCsvBackend (PapaParse + json_each bulk import)"
```

---

## Task 7: `GitHubTransport` HTTP client + `FakeGitHubRemote`

**Files:**
- Create: `src/sync/GitHubTransport.ts`
- Modify: `src/sync/__tests__/fakes.ts` (add `FakeGitHubRemote`)
- Test: `src/sync/__tests__/GitHubTransport.spec.ts`

A thin typed wrapper over the GitHub REST data-API endpoints the backend needs
(getContent, getRef, getCommitTreeSha, createBlob, createTree, createCommit,
updateRef, createRef, validate). No CAS strategy here — the backend in Task 8
composes these. The fake is an in-memory simulation that backs a real
`GitHubTransport` via a custom fetch, so the upcoming backend tests exercise
production transport code with no network.

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/GitHubTransport.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { GitHubTransport, type GitHubFetch } from '../GitHubTransport'

function makeFakeFetch(
  routes: Array<{ url: RegExp; method: string; status: number; body: unknown }>,
) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  const f: GitHubFetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url: url.toString(), method, body })
    for (const r of routes) {
      if (r.url.test(url.toString()) && r.method === method) {
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
  }
  return Object.assign(f, { calls })
}

const cfg = { repo: 'me/mt', branch: 'main', token: 'ghp_test', path: '' }

describe('GitHubTransport', () => {
  it('getContent returns null on 404', async () => {
    expect(await new GitHubTransport(cfg, makeFakeFetch([])).getContent('metadata.json')).toBeNull()
  })

  it('getContent decodes base64 to text on 200', async () => {
    const text = '{"device":"x"}'
    const fetchFn = makeFakeFetch([
      {
        url: /contents\/metadata\.json/,
        method: 'GET',
        status: 200,
        body: { content: btoa(text), encoding: 'base64' },
      },
    ])
    expect(await new GitHubTransport(cfg, fetchFn).getContent('metadata.json')).toBe(text)
  })

  it('getRef returns null on 404 and SHA on 200', async () => {
    expect(await new GitHubTransport(cfg, makeFakeFetch([])).getRef()).toBeNull()
    const ok = makeFakeFetch([
      {
        url: /git\/refs\/heads\/main/,
        method: 'GET',
        status: 200,
        body: { object: { sha: 'abc' } },
      },
    ])
    expect(await new GitHubTransport(cfg, ok).getRef()).toBe('abc')
  })

  it('createBlob POSTs base64-encoded content and returns the SHA', async () => {
    const fetchFn = makeFakeFetch([
      { url: /git\/blobs/, method: 'POST', status: 201, body: { sha: 'b1' } },
    ])
    expect(await new GitHubTransport(cfg, fetchFn).createBlob('hello\n')).toBe('b1')
    expect(fetchFn.calls.find((c) => c.method === 'POST')!.body).toEqual({
      content: btoa('hello\n'),
      encoding: 'base64',
    })
  })

  it('createTree POSTs entries + optional base_tree', async () => {
    const fetchFn = makeFakeFetch([
      { url: /git\/trees/, method: 'POST', status: 201, body: { sha: 't1' } },
    ])
    await new GitHubTransport(cfg, fetchFn).createTree(
      [
        { path: 'metadata.json', sha: 'b1' },
        { path: 'data/locations.csv', sha: 'b2' },
      ],
      'base-tree',
    )
    expect(fetchFn.calls.find((c) => c.method === 'POST')!.body).toEqual({
      base_tree: 'base-tree',
      tree: [
        { path: 'metadata.json', mode: '100644', type: 'blob', sha: 'b1' },
        { path: 'data/locations.csv', mode: '100644', type: 'blob', sha: 'b2' },
      ],
    })
  })

  it('updateRef returns true on 200 and false on 422', async () => {
    const ok = makeFakeFetch([
      { url: /git\/refs\/heads\/main/, method: 'PATCH', status: 200, body: {} },
    ])
    expect(await new GitHubTransport(cfg, ok).updateRef('new')).toBe(true)
    const miss = makeFakeFetch([
      { url: /git\/refs\/heads\/main/, method: 'PATCH', status: 422, body: {} },
    ])
    expect(await new GitHubTransport(cfg, miss).updateRef('new')).toBe(false)
  })

  it('sends Authorization: Bearer on every request', async () => {
    let seenAuth: string | undefined
    const captureFetch: GitHubFetch = async (_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)?.['Authorization']
      return new Response(JSON.stringify({ name: 'mt' }), { status: 200 })
    }
    await new GitHubTransport(cfg, captureFetch).validate()
    expect(seenAuth).toBe('Bearer ghp_test')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/GitHubTransport.spec.ts`
Expected: FAIL — cannot resolve `../GitHubTransport`.

- [ ] **Step 3: Implement `GitHubTransport.ts`**

Create `src/sync/GitHubTransport.ts`:

```typescript
import type { GitHubConfig } from './localState/providerConfig'

/** Injectable fetch — defaults to global fetch, overrideable for tests. */
export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface TreeEntry {
  path: string
  sha: string
}

export interface CommitParams {
  message: string
  tree: string
  parents: string[]
  authorName: string
  authorEmail: string
  /** ISO 8601 UTC, also used as committer.date. */
  atUtc: string
}

/**
 * Typed wrapper over the GitHub REST data API. Knows about authentication
 * and JSON encoding; knows nothing about CAS strategy — composing the
 * blob → tree → commit → ref-update sequence is the backend's job.
 *
 * 404 (not found) and 422 (non-fast-forward) are translated to null /
 * false so the backend can branch on them. Other non-2xx statuses throw
 * with the response body for diagnostics.
 */
export class GitHubTransport {
  constructor(
    private readonly cfg: GitHubConfig,
    private readonly fetch: GitHubFetch = globalThis.fetch.bind(globalThis),
  ) {}

  async validate(): Promise<void> {
    const res = await this.req(`/repos/${this.cfg.repo}`, { method: 'GET' })
    if (!res.ok) throw await asError(res, 'validate')
  }

  async getContent(path: string): Promise<string | null> {
    const res = await this.req(
      `/repos/${this.cfg.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(this.cfg.branch)}`,
      { method: 'GET' },
    )
    if (res.status === 404) return null
    if (!res.ok) throw await asError(res, 'getContent')
    const json = (await res.json()) as { content: string; encoding: string }
    if (json.encoding !== 'base64') {
      throw new Error(`GitHubTransport.getContent: unexpected encoding "${json.encoding}"`)
    }
    return decodeBase64Utf8(json.content)
  }

  async getRef(): Promise<string | null> {
    const res = await this.req(
      `/repos/${this.cfg.repo}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`,
      { method: 'GET' },
    )
    if (res.status === 404) return null
    if (!res.ok) throw await asError(res, 'getRef')
    const json = (await res.json()) as { object: { sha: string } }
    return json.object.sha
  }

  async getCommitTreeSha(commitSha: string): Promise<string> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/commits/${commitSha}`, {
      method: 'GET',
    })
    if (!res.ok) throw await asError(res, 'getCommitTreeSha')
    const json = (await res.json()) as { tree: { sha: string } }
    return json.tree.sha
  }

  async createBlob(content: string): Promise<string> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: encodeBase64Utf8(content), encoding: 'base64' }),
    })
    if (!res.ok) throw await asError(res, 'createBlob')
    return ((await res.json()) as { sha: string }).sha
  }

  async createTree(entries: TreeEntry[], baseTree: string | undefined): Promise<string> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: entries.map((e) => ({
          path: e.path,
          mode: '100644',
          type: 'blob',
          sha: e.sha,
        })),
      }),
    })
    if (!res.ok) throw await asError(res, 'createTree')
    return ((await res.json()) as { sha: string }).sha
  }

  async createCommit(p: CommitParams): Promise<string> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: p.message,
        tree: p.tree,
        parents: p.parents,
        author: { name: p.authorName, email: p.authorEmail, date: p.atUtc },
        committer: { name: p.authorName, email: p.authorEmail, date: p.atUtc },
      }),
    })
    if (!res.ok) throw await asError(res, 'createCommit')
    return ((await res.json()) as { sha: string }).sha
  }

  async updateRef(newSha: string): Promise<boolean> {
    const res = await this.req(
      `/repos/${this.cfg.repo}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`,
      { method: 'PATCH', body: JSON.stringify({ sha: newSha, force: false }) },
    )
    if (res.ok) return true
    if (res.status === 422) return false
    throw await asError(res, 'updateRef')
  }

  async createRef(newSha: string): Promise<void> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${this.cfg.branch}`, sha: newSha }),
    })
    if (!res.ok) throw await asError(res, 'createRef')
  }

  private req(path: string, init: RequestInit): Promise<Response> {
    return this.fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  }
}

async function asError(res: Response, op: string): Promise<Error> {
  const body = await res.text().catch(() => '')
  return new Error(`GitHubTransport.${op}: ${res.status} ${res.statusText} — ${body}`)
}

function encodeBase64Utf8(text: string): string {
  // btoa alone throws on non-Latin-1 — go through UTF-8 bytes first.
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function decodeBase64Utf8(b64: string): string {
  // GitHub's contents API base64 can contain newlines; strip them.
  const binary = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
```

- [ ] **Step 4: Append `FakeGitHubRemote` to `src/sync/__tests__/fakes.ts`**

Append (do not replace existing code) to `src/sync/__tests__/fakes.ts`:

```typescript
import {
  type GitHubFetch,
  GitHubTransport,
  type TreeEntry,
} from '../GitHubTransport'

/**
 * In-memory simulation of the GitHub REST data API. Stores blobs (sha →
 * text), trees (sha → entries), commits, and the single branch HEAD.
 * Backs a real GitHubTransport via a custom fetch, so backend tests
 * exercise production transport code with no network. Enforces
 * fast-forward on updateRef (CAS via 422).
 */
export class FakeGitHubRemote {
  private blobs = new Map<string, string>()
  private trees = new Map<string, TreeEntry[]>()
  private commits = new Map<string, { tree: string; parents: string[]; atUtc: string }>()
  private branchHead: string | null = null
  private nextSha = 1

  fetch(): GitHubFetch {
    return async (url, init) => {
      const u = new URL(url)
      const method = init?.method ?? 'GET'
      const body = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : undefined

      if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) {
        return jsonRes(200, { name: 'mt' })
      }
      const contentsMatch = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/)
      if (method === 'GET' && contentsMatch) {
        const sha = this.pathSha(decodeURIComponent(contentsMatch[1]!))
        if (!sha) return jsonRes(404, { message: 'not found' })
        return jsonRes(200, {
          content: encodeBase64Utf8(this.blobs.get(sha)!),
          encoding: 'base64',
        })
      }
      if (method === 'GET' && /\/git\/refs\/heads\//.test(u.pathname)) {
        if (!this.branchHead) return jsonRes(404, { message: 'not found' })
        return jsonRes(200, { object: { sha: this.branchHead } })
      }
      const commitGet = u.pathname.match(/\/git\/commits\/([^/]+)$/)
      if (method === 'GET' && commitGet) {
        const c = this.commits.get(commitGet[1]!)
        if (!c) return jsonRes(404, { message: 'not found' })
        return jsonRes(200, { tree: { sha: c.tree } })
      }
      if (method === 'POST' && /\/git\/blobs$/.test(u.pathname)) {
        const sha = `b${this.nextSha++}`
        this.blobs.set(sha, decodeBase64Utf8((body as { content: string }).content))
        return jsonRes(201, { sha })
      }
      if (method === 'POST' && /\/git\/trees$/.test(u.pathname)) {
        const sha = `t${this.nextSha++}`
        const entries = (body!.tree as Array<{ path: string; sha: string }>).map((e) => ({
          path: e.path,
          sha: e.sha,
        }))
        if (body!.base_tree) {
          const base = this.trees.get(body!.base_tree as string) ?? []
          const replaced = new Set(entries.map((e) => e.path))
          for (const e of base) if (!replaced.has(e.path)) entries.push(e)
        }
        this.trees.set(sha, entries)
        return jsonRes(201, { sha })
      }
      if (method === 'POST' && /\/git\/commits$/.test(u.pathname)) {
        const sha = `c${this.nextSha++}`
        this.commits.set(sha, {
          tree: body!.tree as string,
          parents: body!.parents as string[],
          atUtc: (body!.committer as { date: string }).date,
        })
        return jsonRes(201, { sha })
      }
      if (method === 'PATCH' && /\/git\/refs\/heads\//.test(u.pathname)) {
        const target = body!.sha as string
        if (!this.isAncestor(this.branchHead, target)) {
          return jsonRes(422, { message: 'Update is not a fast forward' })
        }
        this.branchHead = target
        return jsonRes(200, {})
      }
      if (method === 'POST' && /\/git\/refs$/.test(u.pathname)) {
        this.branchHead = body!.sha as string
        return jsonRes(201, {})
      }
      return jsonRes(404, { message: `unhandled ${method} ${u.pathname}` })
    }
  }

  transport(cfg: { repo: string; branch: string; token: string; path: string }): GitHubTransport {
    return new GitHubTransport(cfg, this.fetch())
  }

  /** Test introspection: the file content at this path in the current HEAD. */
  blobAt(path: string): string | null {
    const sha = this.pathSha(path)
    return sha ? (this.blobs.get(sha) ?? null) : null
  }

  headSha(): string | null {
    return this.branchHead
  }

  /** Test hook: simulate a foreign commit landing while the backend was
   *  doing other work. Used to test CAS-miss behaviour. */
  injectForeignCommit(treeEntries: Array<{ path: string; content: string }>): void {
    const treeEntriesWithSha = treeEntries.map((e) => {
      const sha = `b${this.nextSha++}`
      this.blobs.set(sha, e.content)
      return { path: e.path, sha }
    })
    const treeSha = `t${this.nextSha++}`
    // Merge with current head's tree to preserve untouched paths.
    let merged = treeEntriesWithSha
    if (this.branchHead) {
      const currentTreeSha = this.commits.get(this.branchHead)!.tree
      const base = this.trees.get(currentTreeSha) ?? []
      const replaced = new Set(treeEntriesWithSha.map((e) => e.path))
      merged = [...treeEntriesWithSha, ...base.filter((e) => !replaced.has(e.path))]
    }
    this.trees.set(treeSha, merged)
    const commitSha = `c${this.nextSha++}`
    this.commits.set(commitSha, {
      tree: treeSha,
      parents: this.branchHead ? [this.branchHead] : [],
      atUtc: '2026-05-28T00:00:00.000Z',
    })
    this.branchHead = commitSha
  }

  private pathSha(path: string): string | null {
    if (!this.branchHead) return null
    const commit = this.commits.get(this.branchHead)
    if (!commit) return null
    const tree = this.trees.get(commit.tree)
    return tree?.find((e) => e.path === path)?.sha ?? null
  }

  private isAncestor(ancestor: string | null, descendant: string): boolean {
    if (!ancestor) return true
    let cursor: string | undefined = descendant
    while (cursor) {
      if (cursor === ancestor) return true
      cursor = this.commits.get(cursor)?.parents[0]
    }
    return false
  }
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
// encodeBase64Utf8 and decodeBase64Utf8 are duplicated here to keep the
// fake self-contained — exporting them from the transport would be the
// only alternative, but they're an internal helper there.
function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
```

NOTE: this Task references `GitHubConfig` from `localState/providerConfig.ts`. That
file currently has a `path` field which we drop in Task 13. While `path` exists,
include it in the cfg literals (`path: ''`); after Task 13 the field is gone and
the test cfg objects can omit it. The transport itself never reads `path`.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run src/sync/__tests__/GitHubTransport.spec.ts`
Expected: PASS — ~7 tests.

Run: `npm run test:unit`
Expected: every existing test still passes.

- [ ] **Step 6: Commit**

```bash
git add src/sync/GitHubTransport.ts src/sync/__tests__/GitHubTransport.spec.ts src/sync/__tests__/fakes.ts
git commit -m "Add GitHubTransport + in-memory FakeGitHubRemote for backend tests"
```

---

## Task 8: `GitHubCsvBackend`

**Files:**
- Create: `src/sync/GitHubCsvBackend.ts`
- Test: `src/sync/__tests__/GitHubCsvBackend.spec.ts`

Composes `csvCodec` + `GitHubTransport` + `hashDatabase` into a `SyncBackend`. This
is where the data-API CAS dance lives: blob → tree → commit → ref-update with
`force=false`. `getMetadata()` caches the HEAD commit SHA as the CAS handle for
the next `tryUpload`.

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/GitHubCsvBackend.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { GitHubCsvBackend } from '../GitHubCsvBackend'
import { FakeGitHubRemote } from './fakes'
import { rowsEqual } from '../rows'
import { SYNC_TABLES } from '../syncTables'
import { newId } from '../../db/uuid'
import type { SyncMetadata } from '../types'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

const CUTOFF = '2026-05-01T00:00:00.000Z'
const META = (over: Partial<SyncMetadata> = {}): SyncMetadata => ({
  device: 'dev-A',
  uploadedAtUtc: '2026-05-28T10:00:00.000Z',
  hash: 'sha256:placeholder',
  migrationVersion: 2,
  ...over,
})

describe('GitHubCsvBackend', () => {
  let remotes: FakeGitHubRemote[] = []
  let dbs: Database[] = []
  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
    remotes = []
  })

  function setup() {
    const remote = new FakeGitHubRemote()
    remotes.push(remote)
    const transport = remote.transport({ repo: 'me/mt', branch: 'main', token: 't', path: '' })
    const backend = new GitHubCsvBackend(transport)
    return { remote, backend }
  }

  it('getMetadata returns null on empty repo', async () => {
    const { backend } = setup()
    expect(await backend.getMetadata()).toBeNull()
  })

  it('first-sync upload bootstraps an empty repo', async () => {
    const { backend, remote } = setup()
    const local = await migratedDb()
    dbs.push(local)
    await local.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Home', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    const localHash = await backend.hashDatabase(local)

    await backend.getMetadata() // null
    const ok = await backend.tryUpload(local, META({ hash: localHash }), null)
    expect(ok).toBe(true)
    expect(remote.headSha()).not.toBeNull()
    expect(remote.blobAt('metadata.json')).toContain('"device":"dev-A"')
    expect(remote.blobAt('data/locations.csv')).toContain('Home')
    expect(remote.blobAt('README.md')).toMatch(/Moneytracker/)
    expect(remote.blobAt('.gitattributes')).toMatch(/\.csv text eol=lf/)
  })

  it('getMetadata after first sync returns the uploaded metadata', async () => {
    const { backend } = setup()
    const local = await migratedDb()
    dbs.push(local)
    const hash = await backend.hashDatabase(local)
    await backend.getMetadata()
    await backend.tryUpload(local, META({ hash }), null)

    const m = await backend.getMetadata()
    expect(m).toMatchObject({ device: 'dev-A', hash, migrationVersion: 2 })
  })

  it('downloadDatabase rebuilds a Database byte-identical to what was uploaded', async () => {
    const { backend } = setup()
    const src = await migratedDb()
    dbs.push(src)
    const locId = newId()
    const accId = newId()
    await src.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Home', '[]', ?, ?)`,
      [locId, CUTOFF, CUTOFF],
    )
    await src.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, location_id,
                             colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, 'Checking', 'USD', 0, 2, ?, '#000000', 'wallet', ?, ?)`,
      [accId, locId, CUTOFF, CUTOFF],
    )
    const hash = await backend.hashDatabase(src)
    await backend.getMetadata()
    await backend.tryUpload(src, META({ hash }), null)

    const downloaded = await backend.downloadDatabase()
    dbs.push(downloaded)
    for (const t of SYNC_TABLES) {
      const a = await src.exec<Record<string, unknown>>(
        `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
      )
      const b = await downloaded.exec<Record<string, unknown>>(
        `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
      )
      expect(b.length, t.name).toBe(a.length)
      for (let i = 0; i < a.length; i++) {
        expect(rowsEqual(a[i]!, b[i]!), `${t.name}[${i}]`).toBe(true)
      }
    }
  })

  it('hash in metadata.json matches hashDatabase(downloadedDb)', async () => {
    const { backend } = setup()
    const src = await migratedDb()
    dbs.push(src)
    await src.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'A', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    const srcHash = await backend.hashDatabase(src)
    await backend.getMetadata()
    await backend.tryUpload(src, META({ hash: srcHash }), null)

    const downloaded = await backend.downloadDatabase()
    dbs.push(downloaded)
    expect(await backend.hashDatabase(downloaded)).toBe(srcHash)
  })

  it('tryUpload returns false when a foreign commit lands between getMetadata and tryUpload', async () => {
    const { backend, remote } = setup()
    // Bootstrap.
    const a = await migratedDb()
    dbs.push(a)
    await backend.getMetadata()
    await backend.tryUpload(a, META({ hash: await backend.hashDatabase(a) }), null)

    // First call reads current state, caches HEAD SHA.
    const expectedMeta = await backend.getMetadata()

    // Foreign device pushes between now and our upload.
    remote.injectForeignCommit([
      { path: 'metadata.json', content: '{"device":"foreigner","uploadedAtUtc":"x","hash":"x","migrationVersion":2}' },
    ])

    const b = await migratedDb()
    dbs.push(b)
    await b.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'B', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    const ok = await backend.tryUpload(b, META({ hash: await backend.hashDatabase(b) }), expectedMeta)
    expect(ok).toBe(false)
  })

  it('tryUpload throws if called without a prior getMetadata (and remote exists)', async () => {
    const { backend } = setup()
    // Pre-seed the remote by doing a normal first upload.
    const a = await migratedDb()
    dbs.push(a)
    await backend.getMetadata()
    await backend.tryUpload(a, META({ hash: await backend.hashDatabase(a) }), null)

    // New backend instance, no prior getMetadata().
    const remote2 = remotes[0]!
    const fresh = new GitHubCsvBackend(
      remote2.transport({ repo: 'me/mt', branch: 'main', token: 't', path: '' }),
    )
    const meta = META({ hash: await fresh.hashDatabase(a) })
    await expect(fresh.tryUpload(a, meta, meta)).rejects.toThrow(/getMetadata/)
  })

  it('preserves an unrelated file (README.md) when committing a sync', async () => {
    const { backend, remote } = setup()
    // Bootstrap (creates README, metadata, .gitattributes, all six CSVs).
    const a = await migratedDb()
    dbs.push(a)
    await backend.getMetadata()
    await backend.tryUpload(a, META({ hash: await backend.hashDatabase(a) }), null)
    const readmeAfter1 = remote.blobAt('README.md')

    // Second sync — should keep README intact via base_tree.
    await backend.getMetadata()
    await backend.tryUpload(a, META({ hash: await backend.hashDatabase(a) }), await backend.getMetadata())
    expect(remote.blobAt('README.md')).toBe(readmeAfter1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/GitHubCsvBackend.spec.ts`
Expected: FAIL — cannot resolve `../GitHubCsvBackend`.

- [ ] **Step 3: Implement `GitHubCsvBackend.ts`**

Create `src/sync/GitHubCsvBackend.ts`:

```typescript
import type { Database } from '../db/Database'
import { runMigrations } from '../db/migrations'
import { migration as settingsMigration } from '../db/migrations/001_settings'
import { migration as domainMigration } from '../db/migrations/002_domain_schema'
import { exportAllTables, importAllTables } from './csvCodec'
import { hashDatabase } from './hashDatabase'
import type { GitHubTransport, TreeEntry } from './GitHubTransport'
import type { SyncBackend } from './SyncBackend'
import { SYNC_TABLES } from './syncTables'
import type { SyncMetadata } from './types'

// Stored at the repo root. Source of truth for SyncMetadata; the commit
// message carries the same timestamp + device for github.com browsing but
// metadata.json is what we parse.
const METADATA_PATH = 'metadata.json'
const README_PATH = 'README.md'
const GITATTRIBUTES_PATH = '.gitattributes'

const README_CONTENT = `# Moneytracker database sync

This repository is generated by [Moneytracker](https://github.com/xobotun/moneytracker)
to back up and sync a personal-finance SQLite database across devices. Do
not edit files by hand — the app overwrites everything on the next sync.

\`metadata.json\` is the source of truth for the current snapshot. Each CSV
in \`data/\` is the rows of one domain table, sorted by primary key.
`

const GITATTRIBUTES_CONTENT = `*.csv text eol=lf
*.json text eol=lf
*.md text eol=lf
`

const SYNTHETIC_EMAIL = 'sync@moneytracker.local'

/**
 * GitHub-backed SyncBackend. Encodes the database as CSV-per-table under
 * data/, with metadata.json + README.md + .gitattributes at the root.
 * Commits via the REST data API (blob → tree → commit → ref-update). CAS
 * comes for free from PATCH /git/refs with force: false.
 *
 * Contract notes:
 *  - getMetadata() caches the current branch HEAD commit SHA as the CAS
 *    handle for the next tryUpload(). The cache is on this instance only,
 *    so a fresh GitHubCsvBackend must call getMetadata() before its first
 *    non-null tryUpload — verified by test.
 *  - downloadDatabase() returns a fresh in-memory Database with migrations
 *    applied to metadata.migrationVersion, then CSVs imported via the
 *    bulk json_each path.
 *  - tryUpload exports every CSV plus metadata.json on every call (full
 *    blob upload — see the design doc's "Assumptions accepted on purpose"
 *    for why this is acceptable at personal-finance scale).
 */
export class GitHubCsvBackend implements SyncBackend {
  /** HEAD commit SHA captured by the most recent getMetadata() call.
   *  null = empty repo (no branch ref) or never called. */
  private cachedHeadSha: string | null = null
  private getMetadataCalled = false

  constructor(private readonly transport: GitHubTransport) {}

  async getMetadata(): Promise<SyncMetadata | null> {
    this.getMetadataCalled = true
    // Two reads in parallel would be tempting but: each must complete its
    // own HTTP round-trip, and the cost of doing them sequentially is one
    // extra hop. Keep it simple.
    this.cachedHeadSha = await this.transport.getRef()
    const text = await this.transport.getContent(METADATA_PATH)
    if (!text) return null
    try {
      return JSON.parse(text) as SyncMetadata
    } catch (e) {
      throw new Error(`GitHubCsvBackend: metadata.json is not valid JSON: ${(e as Error).message}`)
    }
  }

  async downloadDatabase(): Promise<Database> {
    const text = await this.transport.getContent(METADATA_PATH)
    if (!text) throw new Error('GitHubCsvBackend.downloadDatabase: no remote (metadata.json missing)')
    const meta = JSON.parse(text) as SyncMetadata

    // Fetch every CSV. Done sequentially because wa-sqlite cannot tolerate
    // concurrent operations against the destination DB anyway; the
    // serialised network cost is the dominant term, not parallelism.
    const bundle = new Map<string, string>()
    for (const t of SYNC_TABLES) {
      const csv = await this.transport.getContent(`data/${t.name}.csv`)
      if (csv === null) {
        throw new Error(`GitHubCsvBackend.downloadDatabase: missing data/${t.name}.csv`)
      }
      bundle.set(t.name, csv)
    }

    // Fresh in-memory DB at the schema version the snapshot was written
    // against. The orchestrator's schema gate handles migrating it up to
    // the local version when required.
    const db = new Database()
    await db.init()
    const allMigrations = [settingsMigration, domainMigration]
    await runMigrations(db, allMigrations.slice(0, meta.migrationVersion))
    await importAllTables(db, bundle)
    return db
  }

  async hashDatabase(db: Database): Promise<string> {
    return hashDatabase(db)
  }

  async tryUpload(
    localDb: Database,
    metadata: SyncMetadata,
    expected: SyncMetadata | null,
  ): Promise<boolean> {
    if (!this.getMetadataCalled) {
      throw new Error(
        'GitHubCsvBackend.tryUpload called without prior getMetadata — the backend needs the cached HEAD SHA',
      )
    }
    // If expected is non-null the caller has seen *some* remote state; if
    // cachedHeadSha is null then the remote was empty when they looked,
    // which contradicts the non-null expected. Either the caller is wrong
    // or the remote was wiped in the meantime — in either case we treat
    // this as a CAS miss rather than blowing up.
    if (expected !== null && this.cachedHeadSha === null) return false

    const csvs = await exportAllTables(localDb)
    const blobs: TreeEntry[] = []
    // metadata.json
    blobs.push({
      path: METADATA_PATH,
      sha: await this.transport.createBlob(JSON.stringify(metadata, null, 2) + '\n'),
    })
    // CSVs
    for (const t of SYNC_TABLES) {
      blobs.push({
        path: `data/${t.name}.csv`,
        sha: await this.transport.createBlob(csvs.get(t.name)!),
      })
    }
    // Bootstrap files only on first sync (no existing tree to inherit
    // from). On subsequent syncs base_tree carries them through.
    const isBootstrap = this.cachedHeadSha === null
    if (isBootstrap) {
      blobs.push({
        path: README_PATH,
        sha: await this.transport.createBlob(README_CONTENT),
      })
      blobs.push({
        path: GITATTRIBUTES_PATH,
        sha: await this.transport.createBlob(GITATTRIBUTES_CONTENT),
      })
    }

    const baseTree = this.cachedHeadSha
      ? await this.transport.getCommitTreeSha(this.cachedHeadSha)
      : undefined
    const treeSha = await this.transport.createTree(blobs, baseTree)
    const commitSha = await this.transport.createCommit({
      message: `Sync ${metadata.uploadedAtUtc} from ${metadata.device}`,
      tree: treeSha,
      parents: this.cachedHeadSha ? [this.cachedHeadSha] : [],
      authorName: metadata.device,
      authorEmail: SYNTHETIC_EMAIL,
      atUtc: metadata.uploadedAtUtc,
    })

    if (isBootstrap) {
      await this.transport.createRef(commitSha)
      this.cachedHeadSha = commitSha
      return true
    }
    const ok = await this.transport.updateRef(commitSha)
    if (ok) this.cachedHeadSha = commitSha
    return ok
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/GitHubCsvBackend.spec.ts`
Expected: PASS — ~8 tests.

Run: `npm run test:unit`
Expected: every test still passes.

- [ ] **Step 5: Commit**

```bash
git add src/sync/GitHubCsvBackend.ts src/sync/__tests__/GitHubCsvBackend.spec.ts
git commit -m "Add GitHubCsvBackend (REST data API with fast-forward CAS)"
```

---

## Task 9: `sqliteBlobCodec` (VACUUM INTO + MemoryVFS)

**Files:**
- Create: `src/sync/sqliteBlobCodec.ts`
- Test: `src/sync/__tests__/sqliteBlobCodec.spec.ts`

The blob path: `VACUUM INTO` a fresh MemoryVFS file, read bytes out as a
`Uint8Array`. Import: open a `Database` against a MemoryVFS pre-populated with the
blob bytes. Follow the recipe in MEMORY `reference_sqlite_export.md`.

- [ ] **Step 1: Read the canonical recipe**

Read the `reference_sqlite_export.md` memory at
`C:\Users\xobotun\.claude\projects\D--Work-moneytracker\memory\reference_sqlite_export.md`.
The implementation should follow that recipe directly. Adjustments only if the
existing `Database` class makes a different choice obvious.

- [ ] **Step 2: Write the failing test**

Create `src/sync/__tests__/sqliteBlobCodec.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { exportDatabaseToBlob, openDatabaseFromBlob } from '../sqliteBlobCodec'
import { rowsEqual } from '../rows'
import { SYNC_TABLES } from '../syncTables'
import { newId } from '../../db/uuid'
import { hashDatabase } from '../hashDatabase'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

const CUTOFF = '2026-05-01T00:00:00.000Z'

describe('sqliteBlobCodec', () => {
  let dbs: Database[] = []
  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
  })

  it('export returns a non-empty Uint8Array', async () => {
    const db = await migratedDb()
    dbs.push(db)
    const blob = await exportDatabaseToBlob(db)
    expect(blob).toBeInstanceOf(Uint8Array)
    expect(blob.length).toBeGreaterThan(0)
    // SQLite header: first 16 bytes are "SQLite format 3\0".
    const header = new TextDecoder().decode(blob.slice(0, 15))
    expect(header).toBe('SQLite format 3')
  })

  it('round-trips a seeded database byte-for-byte (every row in every table)', async () => {
    const src = await migratedDb()
    dbs.push(src)
    const locId = newId()
    const accId = newId()
    await src.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Home', '["a","b"]', ?, ?)`,
      [locId, CUTOFF, CUTOFF],
    )
    await src.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, location_id,
                             colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, 'Checking', 'USD', 100, 2, ?, '#000000', 'wallet', ?, ?)`,
      [accId, locId, CUTOFF, CUTOFF],
    )
    const blob = await exportDatabaseToBlob(src)

    const dst = await openDatabaseFromBlob(blob)
    dbs.push(dst)

    for (const t of SYNC_TABLES) {
      const a = await src.exec<Record<string, unknown>>(
        `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
      )
      const b = await dst.exec<Record<string, unknown>>(
        `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
      )
      expect(b.length, t.name).toBe(a.length)
      for (let i = 0; i < a.length; i++) {
        expect(rowsEqual(a[i]!, b[i]!), `${t.name}[${i}]`).toBe(true)
      }
    }
  })

  it('hashDatabase(roundTripped) === hashDatabase(original)', async () => {
    const src = await migratedDb()
    dbs.push(src)
    await src.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'X', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    const hSrc = await hashDatabase(src)
    const blob = await exportDatabaseToBlob(src)
    const dst = await openDatabaseFromBlob(blob)
    dbs.push(dst)
    expect(await hashDatabase(dst)).toBe(hSrc)
  })

  it('exportDatabaseToBlob does not bump the source mutationCounter', async () => {
    const db = await migratedDb()
    dbs.push(db)
    await db.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'X', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    const before = db.mutationCounter
    await exportDatabaseToBlob(db)
    // VACUUM INTO writes to a separate target file. The source's counter
    // should not advance.
    expect(db.mutationCounter).toBe(before)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/sqliteBlobCodec.spec.ts`
Expected: FAIL — cannot resolve `../sqliteBlobCodec`.

- [ ] **Step 4: Implement `sqliteBlobCodec.ts`**

Implementation follows the MEMORY `reference_sqlite_export.md` recipe. The
contract is:

```typescript
export async function exportDatabaseToBlob(db: Database): Promise<Uint8Array>
export async function openDatabaseFromBlob(blob: Uint8Array): Promise<Database>
```

Key points the agent must get right:
- Export uses `VACUUM INTO 'file:export?vfs=memdb'` (or whichever MemoryVFS name
  the project's wa-sqlite build registers). The target file is in MemoryVFS;
  retrieve its bytes via the MemoryVFS readSync / xRead API.
- Import opens a fresh `Database` whose underlying VFS is MemoryVFS pre-loaded
  with the blob bytes. The `Database` class's `init()` needs to support this —
  if it currently hard-codes IDBBatchAtomicVFS, add a constructor parameter (or
  a static helper) that accepts a different VFS / opens an existing memory
  file.
- The exported blob must include the SQLite file header
  (`SQLite format 3\0` first 16 bytes).
- The `mutationCounter` test pins the contract that export is a read-only
  operation against the source DB — if your implementation calls `db.run` on
  the source for any reason other than the `VACUUM INTO` statement, the
  counter test catches it. The `VACUUM INTO` statement itself does start with
  `VACUUM` which is *not* one of the keywords in the mutationCounter check, so
  it shouldn't bump — good.

If the existing `Database` class is hard-coded to IDBBatchAtomicVFS, factor the
VFS choice out into a constructor parameter as part of this task. Update
`Database.spec.ts` to add a coverage test for the new memory-VFS path if needed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/sqliteBlobCodec.spec.ts`
Expected: PASS — 4 tests.

Run: `npm run test:unit`
Expected: every existing test still passes (Database changes don't regress
elsewhere).

- [ ] **Step 6: Commit**

```bash
git add src/sync/sqliteBlobCodec.ts src/sync/__tests__/sqliteBlobCodec.spec.ts src/db/Database.ts src/db/__tests__/Database.spec.ts
git commit -m "Add sqliteBlobCodec (VACUUM INTO + MemoryVFS round-trip)"
```

---

## Task 10: `BlobTransport` interface + `FakeBlobTransport`

**Files:**
- Create: `src/sync/BlobTransport.ts`
- Modify: `src/sync/__tests__/fakes.ts` (append `FakeBlobTransport`)
- Test: `src/sync/__tests__/fakes.spec.ts` (append tests)

The seam for the SqliteBlobBackend's two transports (Supabase Storage and S3).
Conditional PUT via `If-Match` on the metadata sidecar is the CAS primitive.

- [ ] **Step 1: Create the interface**

Create `src/sync/BlobTransport.ts`:

```typescript
/**
 * Storage primitives the SqliteBlobBackend needs. Conditional PUT with
 * If-Match is the CAS handle: GET the sidecar to capture an ETag, then
 * PUT the new sidecar with If-Match: <etag>. 412 Precondition Failed
 * means another writer beat us — we treat that as CAS miss.
 *
 * The blob (db.sqlite) is uploaded without a conditional check; the
 * sidecar PUT is what serialises updates.
 */
export interface BlobTransport {
  /** GET the metadata sidecar. null = not yet uploaded. */
  getSidecar(): Promise<{ text: string; etag: string } | null>

  /** Unconditionally PUT the database blob bytes. */
  putBlob(bytes: Uint8Array): Promise<void>

  /**
   * Conditional PUT of the sidecar.
   *  - expectedEtag === null → If-None-Match: * (only if sidecar doesn't exist).
   *  - expectedEtag !== null → If-Match: <etag>.
   * Returns false on 412 (CAS miss); throws on other non-2xx.
   */
  putSidecar(text: string, expectedEtag: string | null): Promise<boolean>

  /** GET the database blob. Throws if missing (caller checks sidecar first). */
  getBlob(): Promise<Uint8Array>

  /** Auth-only smoke check for the Settings UI Validate button. */
  validate(): Promise<void>
}
```

- [ ] **Step 2: Append `FakeBlobTransport` to `fakes.ts`**

```typescript
import type { BlobTransport } from '../BlobTransport'

/** In-memory BlobTransport. Tracks etags so conditional PUT works. */
export class FakeBlobTransport implements BlobTransport {
  private blob: Uint8Array | null = null
  private sidecar: { text: string; etag: string } | null = null
  private nextEtag = 1

  async validate(): Promise<void> {}

  async getSidecar(): Promise<{ text: string; etag: string } | null> {
    return this.sidecar ? { ...this.sidecar } : null
  }

  async putBlob(bytes: Uint8Array): Promise<void> {
    this.blob = new Uint8Array(bytes)
  }

  async putSidecar(text: string, expectedEtag: string | null): Promise<boolean> {
    if (expectedEtag === null) {
      if (this.sidecar !== null) return false // 412: was not absent
    } else {
      if (!this.sidecar || this.sidecar.etag !== expectedEtag) return false // 412
    }
    this.sidecar = { text, etag: `e${this.nextEtag++}` }
    return true
  }

  async getBlob(): Promise<Uint8Array> {
    if (!this.blob) throw new Error('FakeBlobTransport: no blob')
    return new Uint8Array(this.blob)
  }

  /** Test hook: simulate a foreign upload. */
  forceSidecar(text: string): void {
    this.sidecar = { text, etag: `e${this.nextEtag++}` }
  }
}
```

- [ ] **Step 3: Append tests in `fakes.spec.ts`**

```typescript
import { FakeBlobTransport } from './fakes'

describe('FakeBlobTransport', () => {
  it('returns null sidecar when empty', async () => {
    expect(await new FakeBlobTransport().getSidecar()).toBeNull()
  })

  it('putSidecar(text, null) succeeds when empty, fails when not empty', async () => {
    const t = new FakeBlobTransport()
    expect(await t.putSidecar('a', null)).toBe(true)
    expect(await t.putSidecar('b', null)).toBe(false)
  })

  it('putSidecar(text, etag) succeeds when etag matches and fails otherwise', async () => {
    const t = new FakeBlobTransport()
    await t.putSidecar('a', null)
    const first = (await t.getSidecar())!
    expect(await t.putSidecar('b', first.etag)).toBe(true)
    expect(await t.putSidecar('c', first.etag)).toBe(false) // stale etag
  })

  it('getBlob throws when no blob has been put', async () => {
    await expect(new FakeBlobTransport().getBlob()).rejects.toThrow(/no blob/)
  })

  it('putBlob then getBlob round-trips bytes', async () => {
    const t = new FakeBlobTransport()
    await t.putBlob(new Uint8Array([1, 2, 3]))
    expect(Array.from(await t.getBlob())).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run src/sync/__tests__/fakes.spec.ts`
Expected: PASS — existing fake-backend tests plus 5 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/sync/BlobTransport.ts src/sync/__tests__/fakes.ts src/sync/__tests__/fakes.spec.ts
git commit -m "Add BlobTransport interface + in-memory FakeBlobTransport"
```

---

## Task 11: `SqliteBlobBackend`

**Files:**
- Create: `src/sync/SqliteBlobBackend.ts`
- Test: `src/sync/__tests__/SqliteBlobBackend.spec.ts`

The blob backend. Composes `sqliteBlobCodec` + `BlobTransport` + `hashDatabase`.
CAS via the sidecar's ETag.

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/SqliteBlobBackend.spec.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { SqliteBlobBackend } from '../SqliteBlobBackend'
import { FakeBlobTransport } from './fakes'
import { rowsEqual } from '../rows'
import { SYNC_TABLES } from '../syncTables'
import { newId } from '../../db/uuid'
import type { SyncMetadata } from '../types'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

const CUTOFF = '2026-05-01T00:00:00.000Z'
const META = (over: Partial<SyncMetadata> = {}): SyncMetadata => ({
  device: 'dev-A',
  uploadedAtUtc: '2026-05-28T10:00:00.000Z',
  hash: 'sha256:placeholder',
  migrationVersion: 2,
  ...over,
})

describe('SqliteBlobBackend', () => {
  let dbs: Database[] = []
  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
  })

  function setup() {
    const transport = new FakeBlobTransport()
    const backend = new SqliteBlobBackend(transport)
    return { transport, backend }
  }

  it('getMetadata returns null when sidecar is empty', async () => {
    const { backend } = setup()
    expect(await backend.getMetadata()).toBeNull()
  })

  it('first-sync upload succeeds with expected = null', async () => {
    const { backend } = setup()
    const local = await migratedDb()
    dbs.push(local)
    await local.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Home', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    await backend.getMetadata()
    const ok = await backend.tryUpload(local, META({ hash: await backend.hashDatabase(local) }), null)
    expect(ok).toBe(true)

    const m = await backend.getMetadata()
    expect(m).toMatchObject({ device: 'dev-A', migrationVersion: 2 })
  })

  it('downloadDatabase rebuilds the uploaded DB byte-for-byte', async () => {
    const { backend } = setup()
    const src = await migratedDb()
    dbs.push(src)
    const locId = newId()
    const accId = newId()
    await src.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Home', '[]', ?, ?)`,
      [locId, CUTOFF, CUTOFF],
    )
    await src.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, location_id,
                             colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, 'Checking', 'USD', 0, 2, ?, '#000000', 'wallet', ?, ?)`,
      [accId, locId, CUTOFF, CUTOFF],
    )
    await backend.getMetadata()
    await backend.tryUpload(src, META({ hash: await backend.hashDatabase(src) }), null)
    const downloaded = await backend.downloadDatabase()
    dbs.push(downloaded)
    for (const t of SYNC_TABLES) {
      const a = await src.exec<Record<string, unknown>>(
        `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
      )
      const b = await downloaded.exec<Record<string, unknown>>(
        `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
      )
      expect(b.length).toBe(a.length)
      for (let i = 0; i < a.length; i++) {
        expect(rowsEqual(a[i]!, b[i]!), `${t.name}[${i}]`).toBe(true)
      }
    }
  })

  it('tryUpload returns false when sidecar etag drifts (CAS miss)', async () => {
    const { backend, transport } = setup()
    const local = await migratedDb()
    dbs.push(local)
    await backend.getMetadata()
    await backend.tryUpload(local, META({ hash: await backend.hashDatabase(local) }), null)

    const expected = await backend.getMetadata()
    // Foreign device updates the sidecar.
    transport.forceSidecar('{"foreign":"yes"}')
    const ok = await backend.tryUpload(local, META({ hash: await backend.hashDatabase(local) }), expected)
    expect(ok).toBe(false)
  })

  it('tryUpload throws if called without prior getMetadata and expected is non-null', async () => {
    const { backend } = setup()
    const local = await migratedDb()
    dbs.push(local)
    const m = META({ hash: await backend.hashDatabase(local) })
    await expect(backend.tryUpload(local, m, m)).rejects.toThrow(/getMetadata/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/SqliteBlobBackend.spec.ts`
Expected: FAIL — cannot resolve `../SqliteBlobBackend`.

- [ ] **Step 3: Implement `SqliteBlobBackend.ts`**

Create `src/sync/SqliteBlobBackend.ts`:

```typescript
import type { Database } from '../db/Database'
import type { BlobTransport } from './BlobTransport'
import { exportDatabaseToBlob, openDatabaseFromBlob } from './sqliteBlobCodec'
import { hashDatabase } from './hashDatabase'
import type { SyncBackend } from './SyncBackend'
import type { SyncMetadata } from './types'

/**
 * SyncBackend that stores the database as a single .sqlite blob plus a
 * metadata sidecar (db.sqlite.json). CAS via the sidecar's ETag — see
 * BlobTransport. Used by Supabase Storage and S3-compatible transports.
 *
 * Sequencing for tryUpload:
 *  1. Put the new blob (no CAS — alone, it means nothing).
 *  2. Put the new sidecar with If-Match: <expected etag>. 412 = CAS miss.
 *
 * If step 2 fails after step 1 succeeded, the orphan blob is left in
 * place. The next successful upload overwrites it. No GC in this plan.
 */
export class SqliteBlobBackend implements SyncBackend {
  private cachedSidecarEtag: string | null = null
  private getMetadataCalled = false

  constructor(private readonly transport: BlobTransport) {}

  async getMetadata(): Promise<SyncMetadata | null> {
    this.getMetadataCalled = true
    const sidecar = await this.transport.getSidecar()
    if (!sidecar) {
      this.cachedSidecarEtag = null
      return null
    }
    this.cachedSidecarEtag = sidecar.etag
    return JSON.parse(sidecar.text) as SyncMetadata
  }

  async downloadDatabase(): Promise<Database> {
    const bytes = await this.transport.getBlob()
    return openDatabaseFromBlob(bytes)
  }

  async hashDatabase(db: Database): Promise<string> {
    return hashDatabase(db)
  }

  async tryUpload(
    localDb: Database,
    metadata: SyncMetadata,
    expected: SyncMetadata | null,
  ): Promise<boolean> {
    if (!this.getMetadataCalled && expected !== null) {
      throw new Error(
        'SqliteBlobBackend.tryUpload called without prior getMetadata — the backend needs the cached sidecar etag',
      )
    }
    const blob = await exportDatabaseToBlob(localDb)
    await this.transport.putBlob(blob)
    const ok = await this.transport.putSidecar(
      JSON.stringify(metadata, null, 2) + '\n',
      expected === null ? null : this.cachedSidecarEtag,
    )
    if (ok) {
      // Re-read to capture the new etag for next call's CAS handle.
      const sidecar = await this.transport.getSidecar()
      this.cachedSidecarEtag = sidecar?.etag ?? null
    }
    return ok
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/SqliteBlobBackend.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/SqliteBlobBackend.ts src/sync/__tests__/SqliteBlobBackend.spec.ts
git commit -m "Add SqliteBlobBackend (blob + ETag-guarded sidecar)"
```

---

## Task 12: `SupabaseStorageTransport`

**Files:**
- Create: `src/sync/SupabaseStorageTransport.ts`
- Test: `src/sync/__tests__/SupabaseStorageTransport.spec.ts`

Supabase Storage exposes a REST API at `{supabaseUrl}/storage/v1/object/{bucket}/{path}`.
Conditional PUTs work via standard `If-Match` / `If-None-Match` headers; the API
returns 412 on a mismatch. Auth is the project anon key as a bearer token.

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/SupabaseStorageTransport.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { SupabaseStorageTransport } from '../SupabaseStorageTransport'

type Captured = { url: string; method: string; headers: Record<string, string>; body: BodyInit | null }

function captureFetch() {
  const calls: Captured[] = []
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    })
    if (calls.at(-1)!.method === 'GET' && url.toString().endsWith('/db.sqlite.json')) {
      return new Response('{"device":"x"}', {
        status: 200,
        headers: { etag: '"abc"', 'content-type': 'application/json' },
      })
    }
    return new Response(null, { status: 200, headers: { etag: '"xyz"' } })
  }
  return { calls, fetchFn }
}

const cfg = {
  url: 'https://proj.supabase.co',
  anonKey: 'eyJ...',
  bucket: 'moneytracker',
}

describe('SupabaseStorageTransport', () => {
  it('getSidecar reads JSON and parses the ETag', async () => {
    const { fetchFn } = captureFetch()
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    const got = await t.getSidecar()
    expect(got).toEqual({ text: '{"device":"x"}', etag: '"abc"' })
  })

  it('putSidecar with expectedEtag === null sends If-None-Match: *', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.putSidecar('{}', null)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.headers['If-None-Match']).toBe('*')
  })

  it('putSidecar with expectedEtag sends If-Match: <etag>', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.putSidecar('{}', '"abc"')
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.headers['If-Match']).toBe('"abc"')
  })

  it('putSidecar returns false on 412', async () => {
    const fetchFn: typeof fetch = async () => new Response(null, { status: 412 })
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    expect(await t.putSidecar('{}', '"stale"')).toBe(false)
  })

  it('every request carries the apikey + Authorization headers', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.validate()
    const c = calls[0]!
    expect(c.headers['apikey']).toBe('eyJ...')
    expect(c.headers['Authorization']).toBe('Bearer eyJ...')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/SupabaseStorageTransport.spec.ts`
Expected: FAIL — cannot resolve.

- [ ] **Step 3: Implement `SupabaseStorageTransport.ts`**

Create `src/sync/SupabaseStorageTransport.ts`:

```typescript
import type { BlobTransport } from './BlobTransport'
import type { SupabaseConfig } from './localState/providerConfig'

type FetchFn = typeof fetch

/**
 * Supabase Storage implementation of BlobTransport.
 *
 * Endpoint shape: {supabaseUrl}/storage/v1/object/{bucket}/{key}
 * Auth: anon key in both `apikey` and `Authorization: Bearer` headers
 *       (Supabase's storage gateway expects both).
 * CAS: standard HTTP conditional headers — If-Match / If-None-Match — on
 *      the sidecar PUT. The gateway returns 412 on mismatch.
 *
 * No @supabase/storage-js dependency; fetch directly so we control headers
 * and don't add 200KB of SDK to the bundle for two endpoints.
 */
export class SupabaseStorageTransport implements BlobTransport {
  constructor(
    private readonly cfg: SupabaseConfig,
    private readonly blobKey: string,
    private readonly sidecarKey: string,
    private readonly fetch: FetchFn = globalThis.fetch.bind(globalThis),
  ) {}

  async validate(): Promise<void> {
    // HEAD on the bucket root would be ideal but Supabase Storage doesn't
    // expose it directly; a HEAD on any object path returns 404 vs. 401
    // and lets us prove auth works.
    const res = await this.fetch(this.url(this.sidecarKey), {
      method: 'HEAD',
      headers: this.authHeaders(),
    })
    if (res.status === 401 || res.status === 403) {
      throw new Error(`SupabaseStorageTransport.validate: auth failed (${res.status})`)
    }
    // 200 or 404 are both fine — they confirm the endpoint reachable + auth ok.
  }

  async getSidecar(): Promise<{ text: string; etag: string } | null> {
    const res = await this.fetch(this.url(this.sidecarKey), {
      method: 'GET',
      headers: this.authHeaders(),
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`SupabaseStorageTransport.getSidecar: ${res.status}`)
    const text = await res.text()
    const etag = res.headers.get('etag') ?? ''
    return { text, etag }
  }

  async putBlob(bytes: Uint8Array): Promise<void> {
    const res = await this.fetch(this.url(this.blobKey), {
      method: 'PUT',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
    })
    if (!res.ok) throw new Error(`SupabaseStorageTransport.putBlob: ${res.status}`)
  }

  async putSidecar(text: string, expectedEtag: string | null): Promise<boolean> {
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      'Content-Type': 'application/json',
    }
    if (expectedEtag === null) headers['If-None-Match'] = '*'
    else headers['If-Match'] = expectedEtag

    const res = await this.fetch(this.url(this.sidecarKey), {
      method: 'PUT',
      headers,
      body: text,
    })
    if (res.status === 412) return false
    if (!res.ok) throw new Error(`SupabaseStorageTransport.putSidecar: ${res.status}`)
    return true
  }

  async getBlob(): Promise<Uint8Array> {
    const res = await this.fetch(this.url(this.blobKey), {
      method: 'GET',
      headers: this.authHeaders(),
    })
    if (!res.ok) throw new Error(`SupabaseStorageTransport.getBlob: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  private url(key: string): string {
    return `${this.cfg.url.replace(/\/$/, '')}/storage/v1/object/${this.cfg.bucket}/${encodeURIComponent(key)}`
  }

  private authHeaders(): Record<string, string> {
    return {
      apikey: this.cfg.anonKey,
      Authorization: `Bearer ${this.cfg.anonKey}`,
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/SupabaseStorageTransport.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/SupabaseStorageTransport.ts src/sync/__tests__/SupabaseStorageTransport.spec.ts
git commit -m "Add SupabaseStorageTransport (fetch + If-Match CAS)"
```

---

## Task 13: `S3Transport` with aws4fetch

**Files:**
- Create: `src/sync/S3Transport.ts`
- Test: `src/sync/__tests__/S3Transport.spec.ts`

S3-compatible transport using `aws4fetch` for sig v4 signing. Works against AWS S3,
Cloudflare R2, Backblaze B2, MinIO. Conditional PUT via `If-Match` / `If-None-Match`
is universally supported on these backends.

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/S3Transport.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { S3Transport } from '../S3Transport'

// aws4fetch.AwsClient wraps fetch under the hood; we intercept at the
// fetch layer (passed as ctor argument) to assert on requests without
// signing complexity.

const cfg = {
  endpoint: 'https://r2.example.com',
  region: 'auto',
  accessKeyId: 'AK',
  secretKey: 'SK',
  bucket: 'mt',
}

function captureFetch() {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: BodyInit | null }> = []
  const fetchFn: typeof fetch = async (url, init) => {
    const req = url instanceof Request ? url : new Request(url, init)
    calls.push({
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers.entries()),
      body: init?.body ?? null,
    })
    if (req.method === 'GET' && req.url.endsWith('/db.sqlite.json')) {
      return new Response('{"device":"x"}', {
        status: 200,
        headers: { etag: '"abc"', 'content-type': 'application/json' },
      })
    }
    return new Response(null, { status: 200, headers: { etag: '"xyz"' } })
  }
  return { calls, fetchFn }
}

describe('S3Transport', () => {
  it('getSidecar returns text + etag on 200', async () => {
    const { fetchFn } = captureFetch()
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    expect(await t.getSidecar()).toEqual({ text: '{"device":"x"}', etag: '"abc"' })
  })

  it('getSidecar returns null on 404', async () => {
    const fetchFn: typeof fetch = async () => new Response(null, { status: 404 })
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    expect(await t.getSidecar()).toBeNull()
  })

  it('putSidecar(null) sends If-None-Match: *', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.putSidecar('{}', null)
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('db.sqlite.json'))!
    expect(put.headers['if-none-match']).toBe('*')
  })

  it('putSidecar(etag) sends If-Match: <etag>', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.putSidecar('{}', '"abc"')
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('db.sqlite.json'))!
    expect(put.headers['if-match']).toBe('"abc"')
  })

  it('putSidecar returns false on 412', async () => {
    const fetchFn: typeof fetch = async () => new Response(null, { status: 412 })
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    expect(await t.putSidecar('{}', '"stale"')).toBe(false)
  })

  it('signed requests carry Authorization with AWS4-HMAC-SHA256', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.validate()
    const auth = calls[0]!.headers['authorization']
    expect(auth).toMatch(/^AWS4-HMAC-SHA256/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/S3Transport.spec.ts`
Expected: FAIL — cannot resolve.

- [ ] **Step 3: Implement `S3Transport.ts`**

Create `src/sync/S3Transport.ts`:

```typescript
import { AwsClient } from 'aws4fetch'
import type { BlobTransport } from './BlobTransport'
import type { S3Config } from './localState/providerConfig'

type FetchFn = typeof fetch

/**
 * S3-compatible BlobTransport using aws4fetch for sig v4. Compatible with
 * AWS S3, R2, B2, MinIO. Conditional PUT via standard If-Match /
 * If-None-Match headers — supported on all the above for modern API
 * versions.
 *
 * endpoint is the bucket-style or virtual-host-style URL prefix; we append
 * /<bucket>/<key> on every request. Most S3-compat backends accept both.
 */
export class S3Transport implements BlobTransport {
  private readonly client: AwsClient
  constructor(
    private readonly cfg: S3Config,
    private readonly blobKey: string,
    private readonly sidecarKey: string,
    fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  ) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretKey,
      region: cfg.region,
      service: 's3',
      // aws4fetch uses globalThis.fetch by default. Inject our captured
      // one for testing by passing it as the fetch option.
      fetch: fetchFn,
    } as unknown as ConstructorParameters<typeof AwsClient>[0])
  }

  async validate(): Promise<void> {
    const res = await this.client.fetch(this.url(this.sidecarKey), { method: 'HEAD' })
    if (res.status === 401 || res.status === 403) {
      throw new Error(`S3Transport.validate: auth failed (${res.status})`)
    }
  }

  async getSidecar(): Promise<{ text: string; etag: string } | null> {
    const res = await this.client.fetch(this.url(this.sidecarKey), { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`S3Transport.getSidecar: ${res.status}`)
    return { text: await res.text(), etag: res.headers.get('etag') ?? '' }
  }

  async putBlob(bytes: Uint8Array): Promise<void> {
    const res = await this.client.fetch(this.url(this.blobKey), {
      method: 'PUT',
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    if (!res.ok) throw new Error(`S3Transport.putBlob: ${res.status}`)
  }

  async putSidecar(text: string, expectedEtag: string | null): Promise<boolean> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (expectedEtag === null) headers['if-none-match'] = '*'
    else headers['if-match'] = expectedEtag
    const res = await this.client.fetch(this.url(this.sidecarKey), {
      method: 'PUT',
      body: text,
      headers,
    })
    if (res.status === 412) return false
    if (!res.ok) throw new Error(`S3Transport.putSidecar: ${res.status}`)
    return true
  }

  async getBlob(): Promise<Uint8Array> {
    const res = await this.client.fetch(this.url(this.blobKey), { method: 'GET' })
    if (!res.ok) throw new Error(`S3Transport.getBlob: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  private url(key: string): string {
    return `${this.cfg.endpoint.replace(/\/$/, '')}/${this.cfg.bucket}/${encodeURIComponent(key)}`
  }
}
```

NOTE: the `fetch` option on aws4fetch's AwsClient constructor depends on the
version. If the version installed doesn't accept it via the constructor, fall
back to instantiating without the option and signing each request manually via
`client.sign(request)` → `fetchFn(signed)`. The test asserts on
`Authorization: AWS4-HMAC-SHA256` which both approaches produce.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/S3Transport.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/S3Transport.ts src/sync/__tests__/S3Transport.spec.ts
git commit -m "Add S3Transport using aws4fetch for sig v4"
```

---

## Task 14: localState updates — `syncError.ts` + drop `github.path`

**Files:**
- Create: `src/sync/localState/syncError.ts`
- Test: `src/sync/__tests__/localState/syncError.spec.ts`
- Modify: `src/sync/localState/providerConfig.ts`
- Modify: `src/sync/__tests__/localState/providerConfig.spec.ts`
- Modify: `src/sync/localState/index.ts`

Two related localState changes batched into one task.

- [ ] **Step 1: Write the failing test for `syncError`**

Create `src/sync/__tests__/localState/syncError.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { loadSyncError, saveSyncError, clearSyncError } from '../../localState/syncError'

describe('syncError', () => {
  beforeEach(() => localStorage.clear())

  it('returns null when no error has been saved', () => {
    expect(loadSyncError()).toBeNull()
  })

  it('round-trips a saved error', () => {
    const e = { atUtc: '2026-05-28T10:00:00.000Z', message: 'Auth failed' }
    saveSyncError(e)
    expect(loadSyncError()).toEqual(e)
  })

  it('clear() removes the saved error', () => {
    saveSyncError({ atUtc: '2026-05-28T10:00:00.000Z', message: 'X' })
    clearSyncError()
    expect(loadSyncError()).toBeNull()
  })
})
```

- [ ] **Step 2: Implement `syncError.ts`**

Create `src/sync/localState/syncError.ts`:

```typescript
import { nullableJsonStore } from './storage'

// The last sync error, surfaced in the Settings UI. Cleared on the next
// successful sync. Following the per-concern split convention from the
// rest of this directory.

export interface SyncError {
  /** ISO 8601 UTC instant at which the error was captured. */
  atUtc: string
  /** Human-readable description (usually the Error.message). */
  message: string
}

const slot = nullableJsonStore<SyncError>('lastSyncError')

export function loadSyncError(): SyncError | null {
  return slot.load()
}

export function saveSyncError(err: SyncError): void {
  slot.save(err)
}

export function clearSyncError(): void {
  slot.save(null)
}
```

- [ ] **Step 3: Run the syncError test to verify it passes**

Run: `npx vitest run src/sync/__tests__/localState/syncError.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 4: Modify `providerConfig.ts` to drop `github.path`**

Read `src/sync/localState/providerConfig.ts`. Find the `GitHubConfig` interface
and remove the `path: string` field. Find `EMPTY_PROVIDER_CONFIG.github` and
remove the `path: 'moneytracker.sqlite'` line.

The reshape is forward-compatible because `jsonStore` does a shallow default-merge;
existing stored values with a stale `path` field will be silently ignored on next
load.

- [ ] **Step 5: Update `providerConfig.spec.ts`**

Open `src/sync/__tests__/localState/providerConfig.spec.ts`. Find any assertion
that references `github.path` (likely in the EMPTY_PROVIDER_CONFIG-defaults test
and the round-trip test) and remove or update them. The "EMPTY_PROVIDER_CONFIG
has sensible defaults" test should no longer assert on `path`. The full-config
round-trip should construct a `GitHubConfig` without `path`.

Run: `npx vitest run src/sync/__tests__/localState/providerConfig.spec.ts`
Expected: PASS.

- [ ] **Step 6: Update the barrel `index.ts`**

Add `export * from './syncError'` to `src/sync/localState/index.ts`.

- [ ] **Step 7: Type-check and run the whole suite**

Run: `npm run type-check`
Expected: zero errors.

Run: `npm run test:unit`
Expected: every test passes.

- [ ] **Step 8: Commit**

```bash
git add src/sync/localState/syncError.ts src/sync/localState/providerConfig.ts src/sync/localState/index.ts src/sync/__tests__/localState/syncError.spec.ts src/sync/__tests__/localState/providerConfig.spec.ts
git commit -m "Add syncError localState slot and drop obsolete github.path field"
```

---

## Task 15: `backendFactory` + `init.ts` wiring

**Files:**
- Create: `src/sync/backendFactory.ts`
- Test: `src/sync/__tests__/backendFactory.spec.ts`
- Modify: `src/db/init.ts`

A pure function `buildBackend(cfg: ProviderConfig): SyncBackend | null`. Plus the
app-launch call in `init.ts` that reads the stored config and registers the
appropriate backend.

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/backendFactory.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildBackend } from '../backendFactory'
import { GitHubCsvBackend } from '../GitHubCsvBackend'
import { SqliteBlobBackend } from '../SqliteBlobBackend'
import { EMPTY_PROVIDER_CONFIG } from '../localState/providerConfig'

describe('buildBackend', () => {
  it('returns null when active is "none"', () => {
    expect(buildBackend({ ...EMPTY_PROVIDER_CONFIG, active: 'none' })).toBeNull()
  })

  it('returns a GitHubCsvBackend when active is "github"', () => {
    const cfg = {
      ...EMPTY_PROVIDER_CONFIG,
      active: 'github' as const,
      github: { repo: 'me/mt', branch: 'main', token: 'ghp_x' },
    }
    expect(buildBackend(cfg)).toBeInstanceOf(GitHubCsvBackend)
  })

  it('returns a SqliteBlobBackend when active is "supabase"', () => {
    const cfg = {
      ...EMPTY_PROVIDER_CONFIG,
      active: 'supabase' as const,
      supabase: { url: 'https://p.supabase.co', anonKey: 'k', bucket: 'mt' },
    }
    expect(buildBackend(cfg)).toBeInstanceOf(SqliteBlobBackend)
  })

  it('returns a SqliteBlobBackend when active is "s3"', () => {
    const cfg = {
      ...EMPTY_PROVIDER_CONFIG,
      active: 's3' as const,
      s3: {
        endpoint: 'https://s3',
        region: 'auto',
        accessKeyId: 'AK',
        secretKey: 'SK',
        bucket: 'mt',
        objectKey: 'db.sqlite',
      },
    }
    expect(buildBackend(cfg)).toBeInstanceOf(SqliteBlobBackend)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/backendFactory.spec.ts`
Expected: FAIL — cannot resolve.

- [ ] **Step 3: Implement `backendFactory.ts`**

Create `src/sync/backendFactory.ts`:

```typescript
import { GitHubCsvBackend } from './GitHubCsvBackend'
import { GitHubTransport } from './GitHubTransport'
import { SqliteBlobBackend } from './SqliteBlobBackend'
import { SupabaseStorageTransport } from './SupabaseStorageTransport'
import { S3Transport } from './S3Transport'
import type { SyncBackend } from './SyncBackend'
import type { ProviderConfig } from './localState/providerConfig'

/**
 * Pure factory from a ProviderConfig to the matching SyncBackend, or null
 * when sync is off. Called by init.ts at app launch and again whenever the
 * user changes provider settings (so no reload is needed).
 *
 * Object keys for the blob path are hard-coded — keeping them out of
 * providerConfig prevents the user from typing them wrong and avoids one
 * more form field. Users who want a different layout can fork.
 */
export function buildBackend(cfg: ProviderConfig): SyncBackend | null {
  switch (cfg.active) {
    case 'none':
      return null
    case 'github':
      return new GitHubCsvBackend(new GitHubTransport(cfg.github))
    case 'supabase':
      return new SqliteBlobBackend(
        new SupabaseStorageTransport(cfg.supabase, 'db.sqlite', 'db.sqlite.json'),
      )
    case 's3':
      return new SqliteBlobBackend(new S3Transport(cfg.s3, cfg.s3.objectKey, `${cfg.s3.objectKey}.json`))
  }
}
```

- [ ] **Step 4: Modify `src/db/init.ts`** to call the factory at app launch

Edit `src/db/init.ts`. Add the imports:

```typescript
import { buildBackend } from '../sync/backendFactory'
import { loadProviderConfig } from '../sync/localState'
```

In the `init()` function, after the database is fully migrated and repositories
are constructed, add:

```typescript
// Build the sync backend from the stored provider config. null when the
// user has not configured a provider; Settings.vue's "Sync now" button
// disables itself in that case.
const cfg = loadProviderConfig()
setSyncBackend(buildBackend(cfg))
```

- [ ] **Step 5: Run all tests + type-check**

Run: `npx vitest run src/sync/__tests__/backendFactory.spec.ts`
Expected: PASS — 4 tests.

Run: `npm run type-check && npm run test:unit`
Expected: zero errors, every test passes.

- [ ] **Step 6: Commit**

```bash
git add src/sync/backendFactory.ts src/sync/__tests__/backendFactory.spec.ts src/db/init.ts
git commit -m "Wire backend factory into init.ts (config → SyncBackend at app launch)"
```

---

## Task 16: `useSyncSettings` — expose `syncNow()` + wire `lastSyncError`

**Files:**
- Modify: `src/views/useSyncSettings.ts`
- Modify: `src/views/__tests__/useSyncSettings.spec.ts`

Second pass on the composable. Task 5 already swapped codec → backend. This task
adds:
- A `syncing` ref (true while a sync is in progress).
- A `lastSyncError` ref + a wired clear-on-success.
- A `syncNow()` async function that invokes `runSync` with the registered backend.

- [ ] **Step 1: Write the failing test**

Append to `src/views/__tests__/useSyncSettings.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useSyncSettings } from '../useSyncSettings'
import { FakeSyncBackend } from '../../sync/__tests__/fakes'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { saveSyncError, loadSyncError } from '../../sync/localState'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

describe('useSyncSettings — syncNow + lastSyncError', () => {
  beforeEach(() => localStorage.clear())

  it('exposes syncing = false initially', () => {
    const s = useSyncSettings({ db: null, backend: null })
    expect(s.syncing.value).toBe(false)
  })

  it('exposes lastSyncError loaded from localState', () => {
    saveSyncError({ atUtc: '2026-05-28T10:00:00.000Z', message: 'Auth failed' })
    const s = useSyncSettings({ db: null, backend: null })
    expect(s.lastSyncError.value?.message).toBe('Auth failed')
  })

  it('syncNow toggles syncing during the call', async () => {
    const db = await migratedDb()
    const backend = new FakeSyncBackend()
    const s = useSyncSettings({ db, backend })
    const p = s.syncNow()
    expect(s.syncing.value).toBe(true)
    await p
    expect(s.syncing.value).toBe(false)
    await db.close()
    await backend.close()
  })

  it('syncNow clears lastSyncError on success', async () => {
    saveSyncError({ atUtc: '2026-05-28T10:00:00.000Z', message: 'old' })
    const db = await migratedDb()
    const backend = new FakeSyncBackend()
    const s = useSyncSettings({ db, backend })
    await s.syncNow()
    expect(s.lastSyncError.value).toBeNull()
    expect(loadSyncError()).toBeNull()
    await db.close()
    await backend.close()
  })

  it('syncNow records an error when the backend throws', async () => {
    const db = await migratedDb()
    const failingBackend = {
      getMetadata: async () => {
        throw new Error('boom')
      },
      downloadDatabase: async () => {
        throw new Error('boom')
      },
      hashDatabase: async () => 'sha256:0',
      tryUpload: async () => false,
    }
    const s = useSyncSettings({ db, backend: failingBackend })
    await s.syncNow()
    expect(s.lastSyncError.value?.message).toMatch(/boom/)
    await db.close()
  })

  it('syncNow is a no-op when no backend is registered', async () => {
    const db = await migratedDb()
    const s = useSyncSettings({ db, backend: null })
    await s.syncNow()
    expect(s.syncing.value).toBe(false)
    expect(s.lastSyncError.value).toBeNull()
    await db.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/views/__tests__/useSyncSettings.spec.ts -t syncNow`
Expected: FAIL — `syncNow`, `syncing`, `lastSyncError` don't exist on the
returned object.

- [ ] **Step 3: Update `useSyncSettings.ts`**

Edit `src/views/useSyncSettings.ts`. Extend the return type:

```typescript
export interface SyncSettings {
  // … existing fields …
  syncing: Ref<boolean>
  lastSyncError: Ref<SyncError | null>
  syncNow: () => Promise<void>
}
```

Add the imports:

```typescript
import {
  loadSyncError,
  saveSyncError,
  clearSyncError,
  type SyncError,
} from '@/sync/localState'
import { runSync } from '@/sync/syncOrchestrator'
import {
  loadLastKnownRemoteState,
  saveLastKnownRemoteState,
} from '@/sync/localState'
```

In the body, add:

```typescript
const syncing = ref(false)
const lastSyncError = ref<SyncError | null>(loadSyncError())

async function syncNow(): Promise<void> {
  if (!deps.db || !deps.backend) return
  if (syncing.value) return
  syncing.value = true
  try {
    await runSync({
      backend: deps.backend,
      deviceName: deviceName.value,
      now: () => new Date(),
      migrate: async () => {
        // App-side migrations live in init.ts's allMigrations array.
        // Re-applying them to a downloaded older-schema DB is the
        // existing pattern — see syncOrchestrator.spec.ts deps fixture.
        // For now: stub that errors loudly if the schema gate ever asks
        // for migration in the UI path; a real impl can lift this into
        // a follow-up plan.
        throw new Error(
          'useSyncSettings.syncNow: schema migration of remote DB is not wired in the minimal UI slice — surface this to the user',
        )
      },
      loadLastKnown: loadLastKnownRemoteState,
      saveLastKnown: saveLastKnownRemoteState,
    })
    clearSyncError()
    lastSyncError.value = null
    // Refresh the displayed snapshots: re-read the local-state slots and
    // recompute the local hash so the UI rows show post-sync values.
    lastKnownRemoteState.value = loadLastKnownRemoteState()
    await recomputeLocalHash()
  } catch (e) {
    const err: SyncError = {
      atUtc: new Date().toISOString(),
      message: (e as Error).message ?? String(e),
    }
    saveSyncError(err)
    lastSyncError.value = err
  } finally {
    syncing.value = false
  }
}

return {
  // … existing fields …
  syncing,
  lastSyncError,
  syncNow,
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/views/__tests__/useSyncSettings.spec.ts`
Expected: every test PASSES (the new ones plus the existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/views/useSyncSettings.ts src/views/__tests__/useSyncSettings.spec.ts
git commit -m "Expose syncNow() + lastSyncError on useSyncSettings"
```

---

## Task 17: `SettingsView.vue` — Validate buttons, Sync now button, error display

**Files:**
- Modify: `src/views/SettingsView.vue`

Three additions to the existing Settings template:
1. A **"Validate"** button next to each provider section's credential fields. Calls
   the matching transport's `validate()` and shows success / failure inline.
2. A **"Sync now"** button in the existing "Sync status" section, disabled when no
   backend is registered or `syncing.value === true`.
3. An inline error display in "Sync status" when `lastSyncError.value !== null`.

No automated test here — the composable's behaviour is covered by Task 16, the
template is presentation. Verification is visual: load the dev server and inspect.

- [ ] **Step 1: Read the current SettingsView**

Read `src/views/SettingsView.vue` to understand the current section structure
(Visual / This device / Sync status / Sync provider sections were added by the
previous sync-settings plan).

- [ ] **Step 2: Add the Sync now button to "Sync status"**

Inside the `<Divider>` block for "Sync status" — at the very end of that block,
after the existing last-sync / current-local / last-seen-remote rows — add:

```vue
<div class="flex flex-col gap-2 mt-2">
  <div class="flex items-center justify-between gap-2">
    <Button
      label="Sync now"
      icon="pi pi-sync"
      :loading="sync.syncing.value"
      :disabled="sync.syncing.value || !backendAvailable"
      @click="sync.syncNow()"
    />
    <span v-if="!backendAvailable" class="text-sm text-surface-500">
      No sync provider configured.
    </span>
  </div>
  <Message
    v-if="sync.lastSyncError.value"
    severity="error"
    :closable="false"
    class="text-sm"
  >
    Sync failed at {{ formatInstant(sync.lastSyncError.value.atUtc) }}:
    {{ sync.lastSyncError.value.message }}
  </Message>
</div>
```

Add to the `<script setup>` imports:

```typescript
import Button from 'primevue/button'
import Message from 'primevue/message'
import { computed } from 'vue'
import { getSyncBackend } from '@/db/init'

// The backend slot is populated by init.ts at app launch from the stored
// provider config. computed() makes it reactive to provider-config edits
// once the corresponding update path bumps a ref — for now it's read-once
// at mount; that's fine for the minimal UI slice.
const backendAvailable = computed(() => getSyncBackend() !== null)
```

The `sync` ref already exists from the previous plan
(`const sync = useSyncSettings({…})`). Update its call to pass the registered
backend:

```typescript
const sync = useSyncSettings({ db: getDatabase(), backend: getSyncBackend() })
```

- [ ] **Step 3: Add the Validate buttons to each provider section**

For the Supabase, S3, and GitHub credential blocks under the existing "Sync
provider" Divider, add a Validate button + inline status. Each block looks
roughly like:

```vue
<div class="flex items-end gap-2">
  <Button
    label="Validate"
    :loading="validating.github"
    :disabled="!canValidateGitHub"
    @click="onValidateGitHub"
  />
  <span v-if="validateStatus.github === 'ok'" class="text-sm text-green-600">
    Connected.
  </span>
  <span v-if="validateStatus.github === 'fail'" class="text-sm text-red-600">
    {{ validateMessage.github }}
  </span>
</div>
```

In `<script setup>`, add the validation handlers:

```typescript
import { reactive } from 'vue'
import { GitHubTransport } from '@/sync/GitHubTransport'
import { SupabaseStorageTransport } from '@/sync/SupabaseStorageTransport'
import { S3Transport } from '@/sync/S3Transport'

type ValidateStatus = 'idle' | 'ok' | 'fail'
const validating = reactive<{ supabase: boolean; s3: boolean; github: boolean }>({
  supabase: false,
  s3: false,
  github: false,
})
const validateStatus = reactive<{ supabase: ValidateStatus; s3: ValidateStatus; github: ValidateStatus }>({
  supabase: 'idle',
  s3: 'idle',
  github: 'idle',
})
const validateMessage = reactive<{ supabase: string; s3: string; github: string }>({
  supabase: '',
  s3: '',
  github: '',
})

const canValidateGitHub = computed(
  () => !!sync.providerConfig.value.github.repo && !!sync.providerConfig.value.github.token,
)

async function onValidateGitHub() {
  validating.github = true
  try {
    const t = new GitHubTransport(sync.providerConfig.value.github)
    await t.validate()
    validateStatus.github = 'ok'
    validateMessage.github = ''
  } catch (e) {
    validateStatus.github = 'fail'
    validateMessage.github = (e as Error).message
  } finally {
    validating.github = false
  }
}
// onValidateSupabase and onValidateS3 follow the same shape using
// SupabaseStorageTransport / S3Transport. canValidateSupabase /
// canValidateS3 are similar computed() checks against required fields.
```

- [ ] **Step 4: Drop the GitHub `path` input from the form**

If `SettingsView.vue` currently renders an input for `sync.providerConfig.value.github.path`,
remove that `<InputText>` block. The `providerConfig.ts` change in Task 14
already removed the field from the type and default.

- [ ] **Step 5: Manual verification**

Run: `npm run dev`

Open the app in a browser, navigate to Settings. Verify:
- "Sync now" button appears in the "Sync status" section.
- Without any provider configured, it shows "No sync provider configured." and the
  button is disabled.
- Configure a GitHub provider (fake credentials are fine — Validate will fail with
  a 401, which is the expected error message). The Validate button under GitHub
  shows a red error.
- Configure a *real* GitHub PAT scoped to a private test repo; the Validate button
  shows "Connected." in green.
- Clicking "Sync now" with the real provider triggers a sync; after it returns,
  the "Last sync" row populates with the new timestamp.
- If the sync fails (e.g., invalid PAT), the error is displayed inline below the
  Sync now button.

State explicitly in your task notes that this manual verification was done, and
list any issues encountered.

- [ ] **Step 6: Commit**

```bash
git add src/views/SettingsView.vue
git commit -m "Add Validate + Sync now buttons and lastSyncError display to Settings"
```

---

## Task 18: Update `TASKS.md` and `REQUIREMENTS.md`

**Files:**
- Modify: `TASKS.md`
- Modify: `REQUIREMENTS.md`

Bookkeeping. Move the External-sync chunks 1 + 2 + minimal-UI-slice from To Do
into Done. Update REQUIREMENTS.md to mark the sync line satisfied to the extent
this plan delivers.

- [ ] **Step 1: Update `TASKS.md`**

Open `TASKS.md`. Under the **Done** section, after the existing
"### Database sync — settings UI, identity, and provider credentials" subsection,
add:

```markdown
### Database sync — GitHub-CSV and SQLite-blob backends

Both SyncBackend implementations, the unified interface, shared content
hashing, and a minimal "Sync now" trigger so the backends can be
exercised end-to-end.

- `SyncBackend` interface (`src/sync/SyncBackend.ts`) replaces the
  previous `SyncProvider` + `DatabaseCodec` seam; the orchestrator no
  longer sees how many files a backend stores.
- Shared content-based `hashDatabase` (`src/sync/hashDatabase.ts`) with
  a `WeakMap` cache keyed on `Database.mutationCounter`. Same logical DB
  yields the same hash across backends.
- `csvCodec` — PapaParse for serialisation, one bulk
  `INSERT … SELECT json_extract(…) FROM json_each(?)` per table on
  import (one Asyncify yield-point per table instead of one per row).
- `GitHubCsvBackend` — REST data API; CAS via `PATCH /git/refs` with
  `force: false`; base_tree preserves any unrelated files in the repo;
  bootstraps empty repos via `POST /git/refs`.
- `sqliteBlobCodec` — `VACUUM INTO` + MemoryVFS round-trip.
- `SqliteBlobBackend` with two transports: `SupabaseStorageTransport`
  (REST + If-Match) and `S3Transport` (aws4fetch sig v4, R2/B2/MinIO
  compatible).
- `backendFactory` wires `providerConfig` → `SyncBackend`; `init.ts`
  registers the backend at app launch.
- Settings UI: per-provider "Validate" button doing an auth-only ping;
  "Sync now" button with inline error display (`lastSyncError`
  localState slot).
- Design: [2026-05-28-sync-backends-design](docs/plans/2026-05-28-sync-backends-design.md)
- Plan: [2026-05-28-sync-backends-plan](docs/plans/2026-05-28-sync-backends-plan.md)
```

In the **To Do** "External sync — provider, UI, and adapters" subsection, prune
the items now delivered (provider implementation, codec, Validate / Sync now
buttons). The remaining items should look like:

```markdown
### External sync — automatic flows and full UI

The backends are done (see Done above). What remains is wiring sync into
the app's automatic flows and the polished UI.

- App-launch automatic fetch populating `lastFetchedRemoteSnapshot` so
  the Settings "Last seen remote" row shows real data without a manual
  Sync now click.
- Blocking overlay during sync with a "use the local database"
  interrupt button.
- Network state / metered-connection detection (PWA heuristic) and the
  auto-sync trigger policy that uses it.
- Conflict-notification email (needs a Supabase Edge Function so the
  loser of every row conflict is preserved off-device).
- Garbage collection of orphan blobs in S3 buckets after CAS misses
  (deferred — at expected sync cadence, orphans are rare and the next
  upload overwrites them).
- See [2026-05-22-database-sync-scenarios.md](docs/scenarios/2026-05-22-database-sync-scenarios.md)
```

- [ ] **Step 2: Update `REQUIREMENTS.md`**

Open `REQUIREMENTS.md`. The Sync section has bullets; mark the ones this plan
satisfies. The pluggable-provider bullet should now point at the new
backend-plan as evidence:

> - Pluggable sync provider — at minimum Supabase, S3-compatible (Backblaze B2 /
>   Cloudflare R2), and GitHub repository as candidates. One is active at a
>   time; credentials for all three are persisted so switching is friction-free.
>   **Satisfied:** see [docs/plans/2026-05-28-sync-backends-plan.md](docs/plans/2026-05-28-sync-backends-plan.md)
>   (GitHubCsvBackend, SqliteBlobBackend with Supabase + S3 transports).

Add a "Satisfied" annotation in the same shape to the device-name and Settings
exposure bullets if they aren't already marked.

- [ ] **Step 3: Commit**

```bash
git add TASKS.md REQUIREMENTS.md
git commit -m "Mark sync backends delivered in TASKS.md and REQUIREMENTS.md"
```

---

## Self-review (post-plan)

Before reporting "plan complete":

1. **Spec coverage.** Walk the design doc section by section. Every section maps
   to at least one task:
   - SyncBackend interface → Task 5
   - hashDatabase + cache → Tasks 1, 2
   - syncColumns + csvCodec → Tasks 3, 6
   - GitHubCsvBackend (layout, CAS, first-sync, auth) → Tasks 7, 8
   - SqliteBlobBackend (sidecar CAS, two transports) → Tasks 9, 10, 11, 12, 13
   - Settings UI changes (Validate + Sync now + error) → Tasks 16, 17
   - localState changes (syncError + drop github.path) → Task 14
   - App-launch wiring → Task 15
   - Bookkeeping → Task 18

2. **Type consistency.** `SyncBackend.tryUpload` signature is identical across
   the interface definition (Task 5), the two concrete backend tests
   (Tasks 8, 11), and `runSync` (Task 5). `hashDatabase` signature matches
   across hashDatabase.ts, both backends, and the composable.

3. **Placeholder scan.** The plan contains no "TBD" / "TODO" markers. Two
   places call out judgement calls explicitly:
   - Task 9 step 4 says "follow the MEMORY recipe" — that recipe is a real
     concrete document, not a placeholder.
   - Task 13 NOTE flags the aws4fetch constructor option fallback. That's a
     real implementation alternative, not a missing detail.

4. **Out-of-scope clarity.** The minimal-UI slice deliberately stubs the
   `migrate` callback in `syncNow` (Task 16) — that's documented inline with a
   loud error and called out as an out-of-scope item.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-28-sync-backends-plan.md`. Two
execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task,
review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans,
batch execution with checkpoints for review.

Which approach?

