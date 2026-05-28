# Sync Backends — GitHub-CSV and SQLite-Blob

**Status:** Design approved 2026-05-28. Implementation plan to follow.

**Goal:** Replace the existing `SyncProvider` + `DatabaseCodec` seam with a
single `SyncBackend` interface, and ship two concrete backends:

- **`GitHubCsvBackend`** — the primary path. Encodes the database as one CSV
  file per domain table inside a GitHub repository, committed via the REST
  data API. A single new transaction shows up as a one-line commit diff that
  github.com renders inline.
- **`SqliteBlobBackend`** — the simpler path. Encodes the database as a single
  `.sqlite` blob via `VACUUM INTO` + MemoryVFS. Two transports: Supabase
  Storage and S3-compatible (Backblaze B2 / Cloudflare R2 / MinIO).

A minimal **"Sync now"** button is added to Settings so the backends can be
exercised end-to-end without waiting on the deferred sync UI.

---

## Why this design

Three principles drove the shape:

1. **Hide storage form behind one interface.** The orchestrator should not
   know whether a remote is one blob or six CSVs. It asks the backend for
   "the remote database" and "try to push this database back" — file count is
   the backend's private detail. Without this, every variation in storage form
   leaks into the orchestrator and its 49 already-passing tests.

2. **Hash by logical content, not by storage form.** If `hashDatabase(db)`
   depended on whether the backend stores CSVs or a SQLite file, switching
   provider would force a spurious re-merge and `lastKnownRemoteState.hash`
   would become provider-bound. A shared content hash keeps the
   "identical-DB short-circuit" meaningful across provider changes.

3. **Use git as a change log, not as object storage.** GitHub's ToS is
   uncomfortable about repos used as generic backup targets. Per-table CSV
   files committed via the data API stay closer to legitimate
   version-controlled-data use (Datasette, git-scraping, etc.): text-only,
   modest size, infrequent commits, private repo by default.

---

## What changes in the already-shipped sync core

The merge engine and `decideSync` scenario logic stay untouched. The seam
between them and the world is rebuilt.

| File | Change |
|---|---|
| `src/sync/SyncProvider.ts` | **Deleted.** Responsibilities move into `SyncBackend`. |
| `src/sync/DatabaseCodec.ts` | **Deleted.** Codec becomes a private helper inside each backend. |
| `src/sync/SyncBackend.ts` | **New.** The single seam (interface + helpers). |
| `src/sync/syncOrchestrator.ts` | `SyncDeps.provider` + `SyncDeps.codec` collapse into `SyncDeps.backend`. `decideSync` is unchanged. `runSync` body uses the new API. |
| `src/sync/__tests__/fakes.ts` | `FakeSyncProvider` + `FakeDatabaseCodec` merge into `FakeSyncBackend` — holds an in-memory `Database` directly; no codec round-trip needed for tests. |
| `src/sync/__tests__/syncOrchestrator.spec.ts` | Cosmetic update to the `deps` factory; the 49 assertions stay as-is. |
| `src/db/init.ts` | `getDatabaseCodec()` / `setDatabaseCodec()` → `getSyncBackend()` / `setSyncBackend()`. |
| `src/views/useSyncSettings.ts` | Takes a `backend` instead of a `codec`. Local-hash computation becomes `backend.hashDatabase(db)`. |

The refactor cost is real but contained: assertions don't change, only the
construction of the dep object and the names of two getters.

---

## The `SyncBackend` interface

```typescript
// src/sync/SyncBackend.ts

import type { Database } from '../db/Database'
import type { SyncMetadata } from './types'

export interface SyncBackend {
  /** Current remote metadata, or null when nothing has ever been uploaded.
   *  Side effect: caches whatever provider-specific handle is needed for the
   *  next tryUpload() to perform CAS (e.g., the current branch HEAD commit
   *  SHA for GitHub, the metadata sidecar's ETag for S3). */
  getMetadata(): Promise<SyncMetadata | null>

  /** Downloads the remote database into a fresh in-memory Database. The
   *  caller owns the lifecycle and closes it after merging. Backend
   *  internals: blob backends open via MemoryVFS; the CSV backend constructs
   *  a fresh DB and bulk-imports each CSV via json_each. */
  downloadDatabase(): Promise<Database>

  /** Canonical hash of `db` in the *shared* logical form (not the storage
   *  form). Cached per Database; recomputed only when the DB's
   *  mutationCounter has advanced. */
  hashDatabase(db: Database): Promise<string>

  /** CAS upload. Exports `localDb` in the backend's storage form and writes
   *  it. Succeeds only if the current remote metadata still equals
   *  `expected` (both null for the first upload). Returns false on a CAS
   *  miss — the orchestrator then re-merges. */
  tryUpload(
    localDb: Database,
    metadata: SyncMetadata,
    expected: SyncMetadata | null,
  ): Promise<boolean>
}
```

`SyncSnapshot`, `SyncFile`, "files" — none of these appear in the public
surface. They live inside each backend.

---

## Shared modules

### `src/sync/hashDatabase.ts` — provider-independent content hash

```typescript
export async function hashDatabase(db: Database): Promise<string>
```

Walks `SYNC_TABLES` in order. For each table, runs `SELECT *
FROM <table> ORDER BY <pk>`, emits a canonical-JSON line per row (keys sorted
alphabetically, no whitespace, NULL ≠ ""), accumulates into a streaming
SHA-256. Returns `"sha256:" + hex`.

Properties:
- Same logical rows → same hash, regardless of storage form.
- `metadata.json.hash` in the GitHub repo carries the *content* hash, not the
  SHA of the CSV files — that's the more useful semantics.
- Provider switch leaves `lastKnownRemoteState.hash` meaningful — no spurious
  re-merge.

**Cache:** module-level `WeakMap<Database, { hash, atMutation }>`. Each call
checks `db.mutationCounter`; recomputes only when the counter has advanced
since the cached entry.

### `src/db/Database.ts` — mutation counter

Adds `mutationCounter: number` (starts at 0). The `run()` write path bumps
it for statements whose leading keyword is one of
`INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP` (case-insensitive). `exec()`
reads don't bump.

A `VACUUM INTO` call inside the blob codec is a write against a *temporary*
target file, not the source — so the source DB's counter is unchanged across
exports. Verified by test.

### `src/sync/syncColumns.ts` — per-table column descriptors

Sits next to `SYNC_TABLES`. For each table, an ordered list of
`{ name, sqlType: 'TEXT' | 'INTEGER' | 'REAL', nullable: boolean }`. Drives:

- The CSV bulk-import SELECT list (`CAST(json_extract(value, '$.col') AS
  INTEGER)` for INTEGER columns, `nullif(json_extract(...), '')` for
  nullable columns).
- Forward-compatibility on import: if the CSV is missing a column the local
  schema has, `json_extract` returns NULL — fine for nullable columns;
  flagged loudly for non-nullable ones.

### `src/sync/csvCodec.ts` — CSV ↔ Database

**Export.** For each table in `SYNC_TABLES`:

```typescript
const rows = await db.exec(`SELECT * FROM ${name} ORDER BY ${pk}`)
return Papa.unparse(rows, { header: true, newline: '\n' })
```

PapaParse handles quoting, embedded newlines, and JSON-literal columns
automatically per RFC 4180. Output is deterministic because:
- Column order comes from `syncColumns` (not from JS object enumeration).
- Row order comes from `ORDER BY <pk>` — UUIDv7 PKs sort chronologically.
- Newline pinned to `\n` (matches `.gitattributes`).

**Import.** For each table:

```typescript
const parsed = Papa.parse<Record<string, string>>(csvText, {
  header: true,
  skipEmptyLines: true,
  dynamicTyping: false,   // we control coercion in SQL
})

const columns = syncColumnsFor(table)              // ordered list of descriptors
const columnList = columns.map(c => c.name).join(', ')
const selectList = columns.map(c =>
  c.sqlType === 'INTEGER' ? `CAST(json_extract(value, '$.${c.name}') AS INTEGER)` :
  c.sqlType === 'REAL'    ? `CAST(json_extract(value, '$.${c.name}') AS REAL)` :
  c.nullable              ? `nullif(json_extract(value, '$.${c.name}'), '')` :
                            `json_extract(value, '$.${c.name}')`
).join(',\n  ')

await db.run(
  `INSERT INTO ${table} (${columnList})
   SELECT ${selectList}
   FROM json_each(?)`,
  [JSON.stringify(parsed.data)],
)
```

One bulk INSERT per table — much faster than N parametrized inserts through
wa-sqlite's Asyncify layer (every `await` is a yield point, and there is
*no* concurrent-call safety on the async build, so each row would otherwise
be a serial round-trip).

### `src/sync/sqliteBlobCodec.ts` — Blob ↔ Database

Export via `VACUUM INTO 'file:export?vfs=memdb'` against a fresh MemoryVFS
target, then read the file out of the MemoryVFS as a `Uint8Array`. Import
opens a fresh `Database` against a MemoryVFS pre-populated with the blob's
bytes. The technique is documented in the `reference_sqlite_export` memory.

---

## `GitHubCsvBackend`

### Repo layout

```
/                              ← repo root, branch defaults to `main` (configurable)
  README.md                    ← short note: "Generated by Moneytracker;
                                 do not edit by hand"
  metadata.json                ← {
                                   "device":           "Office iMac · 7b22ee01",
                                   "uploadedAtUtc":    "2026-05-28T10:05:00.000Z",
                                   "hash":             "sha256:abc123…",
                                   "migrationVersion": 2
                                 }
  data/
    locations.csv
    tags.csv
    accounts.csv
    exchange_rates.csv
    account_groupings.csv
    transactions.csv
  .gitattributes               ← `*.csv text eol=lf`
```

### Operations

- **`getMetadata()`**
  - `GET /repos/{owner}/{repo}/contents/metadata.json?ref={branch}` → parse
    JSON. 404 → return null.
  - As a side effect, `GET /repos/{owner}/{repo}/git/refs/heads/{branch}` to
    capture the current HEAD commit SHA in a private instance field. This is
    the CAS handle the next `tryUpload` consumes. If `tryUpload` is called
    without a prior `getMetadata`, throw (programming error).

- **`downloadDatabase()`**
  - In parallel: fetch `metadata.json` + every `data/*.csv` via
    `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}`. The contents
    API returns base64; decode → UTF-8 text.
  - Construct a fresh in-memory `Database`, run migrations up to
    `metadata.migrationVersion` (so its schema matches what the CSVs were
    written against), then bulk-import each CSV via `csvCodec`.
  - Return the open `Database`. Orchestrator closes it.

- **`hashDatabase(db)`** — delegates to `hashDatabase`.

- **`tryUpload(localDb, meta, expected)`** — the data API CAS dance:
  1. Export local DB → `metadata.json` + six CSV strings.
  2. `POST /repos/{o}/{r}/git/blobs` for each file → blob SHAs.
  3. `POST /repos/{o}/{r}/git/trees` with `base_tree` = current commit's
     `tree.sha` (preserves any other files in the repo — important when the
     user picked an existing repo with a README, CI config, etc.) + our new
     blob entries.
  4. `POST /repos/{o}/{r}/git/commits` with:
     - `tree`: the new tree SHA.
     - `parents`: `[cached HEAD SHA]`, or `[]` for first-sync into an empty repo.
     - `author` and `committer` both `{ name: deviceName, email:
       'sync@moneytracker.local', date: meta.uploadedAtUtc }`.
     - `message`: `Sync ${meta.uploadedAtUtc} from ${deviceName}`.
  5. `PATCH /repos/{o}/{r}/git/refs/heads/{branch}` with `sha` = the new
     commit SHA, `force: false`.
     - `200 OK` → return `true`.
     - `422 Reference cannot be updated` → CAS miss → return `false`.
  6. Empty-repo bootstrap: if `getMetadata()` saw no branch ref at all
     (`404` on `GET /git/refs/heads/{branch}`), step 5 becomes a
     `POST /repos/{o}/{r}/git/refs` to create the ref pointing at our new
     commit (which itself has no parent).

### Auth and Settings UI

- Fine-grained PAT, scoped to one repo, with `Contents: write` +
  `Metadata: read`.
- Stored in `providerConfig.github.token` (already there). Plaintext per the
  existing design note: the realistic threat is XSS, which already exfiltrates
  the entire SQLite database, so at-rest encryption of the token gains
  nothing meaningful.
- Settings UI: **Validate** button does a no-op `GET /repos/{o}/{r}` and
  surfaces success/failure inline so the user can verify before leaving the
  screen.

### Provider-config reshape

Today's `github` block: `{ repo, branch, path, token }`. After this plan:

| Field | Before | After |
|---|---|---|
| `repo` | `"me/mt"` | `"me/mt"` (unchanged — single "owner/repo" string) |
| `branch` | `"main"` | `"main"` |
| `path` | `"moneytracker.sqlite"` | **dropped** — layout is fixed (`data/*.csv` at root) |
| `token` | PAT | PAT |

Migration of stored configs: on load, the existing `jsonStore` shallow-merge
silently ignores the stale `path` field. No data loss.

### Rate limits

5000 req/hour authenticated. One sync ≈ 10–15 requests. Even at one sync
per minute (60/hour, ~900 req/hour) we stay well under the cap.

---

## `SqliteBlobBackend`

### Layout (per transport)

```
<bucket>/
  db.sqlite           ← the .sqlite blob produced by sqliteBlobCodec
  db.sqlite.json      ← metadata sidecar (same shape as GitHub's metadata.json)
```

The sidecar is the source of truth for `SyncMetadata`. The blob does not
need to be parsed to know what's in it.

### CAS via ETag on the sidecar

1. `GET db.sqlite.json` → capture ETag (`E1`) and parse JSON.
2. `PUT db.sqlite` with the new blob (no CAS — the blob alone has no
   meaning until the sidecar points at it).
3. `PUT db.sqlite.json` with `If-Match: E1`.
   - `200 / 201` → success.
   - `412 Precondition Failed` → CAS miss → return `false`.

If the CAS fails after the blob has been written, the orphan blob is left
in place. The next successful upload overwrites it. No GC in this plan;
worst case the bucket holds one stale blob per CAS miss.

### Transports

- **`SupabaseStorageTransport(client, bucket, dbKey, metaKey)`** — uses the
  Supabase Storage REST API for GET/PUT with conditional headers.
- **`S3Transport({ endpoint, region, accessKeyId, secretAccessKey, bucket,
  dbKey, metaKey })`** — fetch + AWS sig v4 signing. Compatible with R2,
  B2, MinIO. Sig v4 is small enough to hand-roll (~80 lines) but if a
  vetted library is already in the bundle we use that.

### Why a sidecar instead of S3 object metadata

S3 supports `x-amz-meta-*` headers for arbitrary user metadata, but they're
limited to ASCII strings and the maximum total size is small. Worse, they're
returned only on `HEAD`/`GET` — we'd be requesting the blob's metadata
constantly just to read the hash. A separate small JSON sidecar is one HTTP
call to read, always text, and survives transport quirks.

---

## App-launch wiring

```typescript
// src/db/init.ts
import { buildBackend } from '../sync/backendFactory'
import { loadProviderConfig } from '../sync/localState'

export async function init(): Promise<void> {
  // … existing DB init + migrations …
  const cfg = loadProviderConfig()
  setSyncBackend(buildBackend(cfg))   // null when cfg.active === 'none'
}
```

`src/sync/backendFactory.ts` — a small pure function:

```typescript
export function buildBackend(cfg: ProviderConfig): SyncBackend | null {
  switch (cfg.active) {
    case 'none':     return null
    case 'github':   return new GitHubCsvBackend(new GitHubTransport(cfg.github))
    case 'supabase': return new SqliteBlobBackend(new SupabaseStorageTransport(cfg.supabase))
    case 's3':       return new SqliteBlobBackend(new S3Transport(cfg.s3))
  }
}
```

When the user changes the active provider in Settings (or edits
credentials), the factory is re-invoked and `setSyncBackend` is called
again. No reload needed.

---

## Settings UI — additions to the existing "Sync status" + "Sync provider" sections

- **Validate** button per provider section (Supabase, S3, GitHub). Auth-only
  ping that surfaces success/failure inline. No DB I/O.
- **Sync now** button in "Sync status". Disabled when:
  - No backend is configured (`providerConfig.active === 'none'`).
  - A sync is currently in progress (`syncing.value === true`).
- On click, runs `runSync(deps)` with the currently registered backend.
  On completion:
  - The existing rows (last sync, last seen remote, current local DB hash)
    refresh from the updated `lastKnownRemoteState` and the now-current
    `localHash`.
  - Errors are stored in a new local-state slot `lastSyncError` (timestamp
    + message) and shown inline; cleared on the next successful sync.

The blocking overlay and "use the local database" interrupt button are
**not** in this plan.

---

## Testing discipline

For **every** codec and backend, the test suite includes:

### Round-trip (the hard contract)
1. Seed a fresh `Database` with non-trivial rows in every domain table —
   including a row with NULL fields, a row with embedded newlines in a TEXT
   column, a row with JSON columns containing nested values, a money triplet,
   a `LocalMoment` pair.
2. `await backend.tryUpload(db, meta, null)` against a fake transport.
3. `const restored = await backend.downloadDatabase()`.
4. Assert every row in every table is byte-identical to the seeded value
   (using the existing `rowsEqual` helper from `src/sync/rows.ts`, which
   already handles Uint8Array byte-by-byte).

### Targeted serialise tests
- NULLs (nullable column with `null` → empty CSV cell → null on round-trip).
- Empty string distinct from NULL.
- TEXT with embedded `\n`, `,`, `"`.
- JSON columns (`tags`, `synonyms`, `accounts_ids`, `exchange_rates.rates`).
- Money triplets (`*_value` INTEGER + `*_scale` INTEGER + `*_currency` TEXT).
- `LocalMoment` (`*_local` TEXT offset-bearing ISO + `*_zone` TEXT IANA).

### Targeted deserialise tests
- The same shapes coming back, asserting both type (e.g., `typeof === 'number'`
  for INTEGER columns post-`json_each` CAST) and value.
- Forward-compatibility: CSV missing a nullable column the local schema added
  → row imports with that column NULL.

### Backend behaviour
- `getMetadata()` returns `null` on an empty target.
- `tryUpload` succeeds on first sync (`expected === null`).
- `tryUpload` concurrent CAS miss — simulate a second writer between
  `getMetadata` and `tryUpload`, expect `false`. Orchestrator-level retry
  (in the existing `runSync` tests) covers the re-merge path.
- `getMetadata → tryUpload → getMetadata` round-trip — the second read sees
  the new metadata.

### Hash caching
- `hashDatabase(db)` called twice with no intervening write returns the same
  string and only computes the hash once (verified via a counter on a test
  shim).
- A write to any domain table bumps `db.mutationCounter`, invalidating the
  cache.
- `VACUUM INTO` against a target file does **not** bump the source DB's
  counter.

### Fake transports
- `FakeGitHubTransport` — a deterministic simulation of the REST data API:
  in-memory blob store keyed by SHA, in-memory tree store, in-memory commit
  store, an explicit branch HEAD pointer, `PATCH /refs` enforces
  fast-forward.
- `FakeBlobTransport` — in-memory key→bytes map with ETag tracking and
  conditional PUT semantics.

These let the backend tests run with no network I/O and no flakiness.

---

## Task ordering (refined later via `writing-plans`)

1. **`SyncBackend` interface refactor.** Delete `SyncProvider.ts` and
   `DatabaseCodec.ts`; add `SyncBackend.ts`; update orchestrator and
   `FakeSyncBackend`; cosmetic test updates. Tests must still pass.
2. **`mutationCounter` on `Database`** + shared `hashDatabase` with the
   `WeakMap` cache + tests.
3. **`syncColumns`** per-table column descriptors + tests.
4. **`csvCodec`** — export, import, round-trip + targeted serialise /
   deserialise.
5. **`GitHubCsvBackend`** + `FakeGitHubTransport` + backend behaviour tests.
6. **`sqliteBlobCodec`** — `VACUUM INTO` + MemoryVFS + round-trip.
7. **`SupabaseStorageTransport`** + tests.
8. **`S3Transport`** (sig v4) + tests.
9. **`backendFactory`** + `init.ts` wiring.
10. **Settings UI**: providerConfig schema reshape (drop `github.path`),
    Validate buttons, Sync now button, error display.
11. **`useSyncSettings`** — take a backend, expose `syncNow()` handler.
12. **`TASKS.md` / `REQUIREMENTS.md`** update — move "External sync"
    chunks 1 + 2 + minimal-UI-slice to Done; keep chunks 3 + 4 + 5
    + conflict-notification email as To Do.

---

## Out of scope (deferred)

- App-launch automatic fetch populating `lastFetchedRemoteSnapshot`
  (TASKS chunk 3).
- Blocking sync overlay + "use the local database" interrupt button
  (rest of TASKS chunk 4).
- Network state / metered-connection detection, auto-sync triggers
  (TASKS chunk 5).
- Conflict-notification email — needs a Supabase Edge Function; separate
  plan.
- Garbage collection of orphan blobs in S3 buckets after CAS misses.

---

## Assumptions accepted on purpose

- **Whole-file upload to GitHub on every change.** The REST data API
  uploads each changed file as a complete blob; even a one-line CSV change
  re-uploads the whole file. True git delta transfer would require
  `isomorphic-git` + a CORS proxy (third-party trust or self-hosted
  infrastructure), which we judged not worth the cost at personal-finance
  scale. The `SyncBackend` seam means we can swap later without touching the
  merge engine.
- **Orphan blobs in S3 after CAS misses** stay until the next successful
  upload overwrites them. No GC. Worst case: one stale blob per miss; harmless.
- **PAT plaintext in localStorage.** The realistic threat (XSS) already
  exfiltrates the SQLite database; at-rest encryption of tokens raises no
  meaningful bar. Same reasoning as the existing sync-settings design.
- **Private repo by default, not enforced.** Settings UI nudges toward
  private and explains why, but the user can configure a public repo if they
  want.
