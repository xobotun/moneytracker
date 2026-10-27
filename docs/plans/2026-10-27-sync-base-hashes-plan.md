# Sync Base Hashes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merge tells which side changed a row by comparing the row's hash with the hash both sides last agreed on (option A), instead of comparing its timestamps with this device's last sync.

**Architecture:** A device-local `sync_base` table holds one hash per synced row, as of the last state this device and the remote agreed on, plus a one-row `sync_base_info` saying which remote and schema version it belongs to. The merge engine takes a `ChangeDetector`: the base when it is valid for this remote, otherwise today's cutoff. The base is rewritten from the remote's rows inside every merge transaction, and from the uploaded rows after every successful upload.

**Tech Stack:** TypeScript, wa-sqlite, Vitest, Web Crypto (`crypto.subtle.digest('SHA-256')`).

**Spec:** docs/plans/2026-10-26-sync-change-detection.md (option A, chosen 2026-10-27). Where this plan deviates from it, the deviation is named and argued in the task.

## Global Constraints

- Columns use the five affinity keywords only, with the semantic type in a comment; a migration's `up` starts with a statement keyword, not a comment (CLAUDE.md, SQLite Conventions).
- Multi-statement units use `db.transaction(async (tx) => …)` and only `tx` inside; no network work inside a transaction.
- `SYNC_TABLES` stays the list of merged tables: the new tables are device-local and are not added to it (`syncTables.spec.ts` keeps its 8 names).
- `hashDatabase` keeps returning exactly today's value for the same rows (remote metadata holds it).
- Match the surrounding code: comment density, naming, idiom. No new dependencies.
- Every task ends with `npx vitest run`, `npm run type-check` and `npm run lint` clean (lint auto-fixes; commit its changes).

## Decisions (binding for every task)

1. **Row hash.** `rowHash(table, row)` = lower-case hex of the first 16 bytes of SHA-256 over a UTF-8 line:
   - a live row: the line `hashDatabase` already writes for it (`${table.name} ${canonical JSON without EQUALITY_IGNORED_COLUMNS}`), shared through one exported function so the two can never drift;
   - a deleted row (`deleted_at_utc` not null): `` `${table.name} ${JSON.stringify([row[table.pk], row.deleted_at_utc])}` `` — its identity and its delete time only.

   *Deviation from the spec (option A's last downside).* The spec suggests normalising rows through the merge-chain map, or recording stamp-less rewrites in the base. Both need the base rows, which A does not keep. A tombstone, though, changes only by being deleted or restored; the stamp-less rewrites that matter (a user's merge rewriting deleted rows, the sync repair's redirect) touch its references, never its delete time. Hashing a tombstone as identity + delete time makes those rewrites invisible, which is what keeps a concurrent restore (`cornerCases/merges.spec.ts`). Stamp-less rewrites of *live* rows (redirect, lift) still count as changes: they meet a real edit as a conflict, which latest-wins settles correctly because the repair kept the older stamp; the cost is a reported conflict, not a lost change.
2. **Rows neither side changed but that differ.** With the base, that can only be two tombstones that differ in what the hash leaves out. They are settled with `resolveConflict` (deterministic) and **not reported**. With the cutoff they stay reported conflicts, as today.
3. **When the base is used.** Only when `sync_base_info` exists, its `remote_id` equals `backend.remoteId` and its `schema_version` equals the local schema version. Otherwise the merge uses today's cutoff (`lastKnown?.uploadedAtUtc ?? EPOCH_UTC`). A base from another remote describes another lineage (a stale remote's old rows would look "changed" and win); after a migration every row's line changes.
4. **When the base is written** (always replacing the whole base and the info row in one transaction):
   - inside `mergeDatabases`' transaction, after the repairs: the **remote's** rows (the downloaded database is the common ancestor of the merged local database and anything uploaded after it). This makes a compare-and-swap retry compare against the remote it just merged, and rolls back with a failed merge;
   - after every successful `tryUpload` (first upload, upload-local, merge): a snapshot of the local rows taken **just before** `tryUpload`. A base may be older than what was uploaded (an app write between snapshot and export), never newer;
   - on decision `none`, unless the info already names this remote, this schema version and `remoteMeta.hash`: a snapshot, written only if its database hash equals `remoteMeta.hash`.
5. **Remote identity.** `SyncBackend.remoteId: string`, no secrets: `github:${repo}@${branch}`, `s3:${endpoint}/${bucket}/${objectKey}`, `supabase:${url}/${bucket}/${blobKey}`. Transports own it (`GitHubTransport.remoteId`, `BlobTransport.remoteId`); backends forward it.
6. **Upload stamps.** Each upload's metadata hash is the snapshot's `databaseHash` (equal to `hashDatabase` of the same rows): one walk instead of two on the merge path, and the stamp describes the rows the base holds.

## Review Focus

1. An app write between the snapshot and the upload's export: the base must be the older state, never the newer (decision 4).
2. A compare-and-swap retry where the other device restored a row this device's first attempt took as deleted: the restore must survive (base from the merge transaction).
3. Switching provider to a remote holding older data, or a schema migration: the merge must fall back to the cutoff, not trust a base from another lineage (decision 3).
4. A tombstone rewritten without a stamp (merge of its parent) on one device while the other restores it: the restore wins and no conflict is reported (decision 1).
5. An existing install with no base: its first merge uses the cutoff and writes a base; every later merge uses the base.

---

### Task 1: Row hashes and the stored base

**Files:**
- Create: `src/sync/syncBase.ts`, `src/db/migrations/003_sync_base.ts`, `src/sync/__tests__/syncBase.spec.ts`
- Modify: `src/db/migrations/index.ts` (register 003), `src/sync/hashDatabase.ts` (export the shared line function, use it), `src/sync/syncTables.ts` (comment: the two device-local tables)

**Interfaces:**
- Produces (`src/sync/syncBase.ts`):
  - `type RowHashes = Map<string, Map<string, string>>` — table name → primary key → `rowHash`.
  - `interface Snapshot { databaseHash: string; rows: RowHashes }`
  - `interface BaseSource { remoteId: string; schemaVersion: number }`
  - `interface SyncBaseInfo extends BaseSource { databaseHash: string }`
  - `rowHash(table: SyncTable, row: SyncRow): Promise<string>`
  - `snapshotDatabase(db: Database): Promise<Snapshot>` — reads every `SYNC_TABLES` row inside one `db.transaction` (a consistent read), hashes after it; `databaseHash` equals `hashDatabase(db)` for the same rows.
  - `readSyncBaseInfo(db: SqlExecutor): Promise<SyncBaseInfo | null>`
  - `readSyncBase(db: SqlExecutor): Promise<RowHashes>`
  - `writeSyncBase(tx: SqlExecutor, snapshot: Snapshot, source: BaseSource): Promise<void>` — replaces every `sync_base` row and the info row; the caller provides the transaction. Bulk insert through `json_each` (one statement), like `redirectTagReferencesByMap`.
- Produces (`src/sync/hashDatabase.ts`): `canonicalLine(table: SyncTable, row: SyncRow): string` — the exact line `hashDatabase` hashes today (with the trailing `\n` left to `hashDatabase`).

Migration 003 (`version: 3`):

```sql
CREATE TABLE sync_base (
  table_name TEXT NOT NULL,  -- a SYNC_TABLES name
  pk         TEXT NOT NULL,  -- the row's primary key
  row_hash   TEXT NOT NULL,  -- rowHash(): hex of the first 16 bytes of SHA-256
  PRIMARY KEY (table_name, pk)
) WITHOUT ROWID;
CREATE TABLE sync_base_info (
  id             INTEGER PRIMARY KEY CHECK (id = 1),  -- a single row
  remote_id      TEXT NOT NULL,     -- SyncBackend.remoteId the base was agreed with
  database_hash  TEXT NOT NULL,     -- hashDatabase() of the rows the base holds
  schema_version INTEGER NOT NULL   -- migration version the rows were hashed at
)
```

Both are device-local like `settings`: no sync columns, not in `SYNC_TABLES`, not exported to CSV (they still ride along in a SQLite-blob upload; nobody reads them there).

- [ ] **Step 1: Write the failing tests** in `src/sync/__tests__/syncBase.spec.ts` (use `newMigratedDb` / `seed*` from `helpers.ts`):
  - `rowHash` is 32 lower-case hex characters, equal for equal rows, different when any hashed column differs;
  - `rowHash` ignores `EQUALITY_IGNORED_COLUMNS` (an account's `balance_value`; an applied rate's `updated_at_utc`);
  - a deleted tag hashes the same after its `parent_id` / `name` change, and differently after its `deleted_at_utc` changes or it is restored;
  - `snapshotDatabase(db).databaseHash === await hashDatabase(db)` on a seeded database with live and deleted rows in several tables (call `__resetHashCache` first);
  - `writeSyncBase` then `readSyncBase` / `readSyncBaseInfo` round-trips; a second write replaces the first entirely (a row left out is gone); a fresh database has no info (`null`) and an empty base;
  - `hashDatabase.spec.ts` keeps passing unchanged (pins the value).
- [ ] **Step 2: Run** `npx vitest run src/sync/__tests__/syncBase.spec.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** migration 003, `canonicalLine` (move the line-building out of `hashDatabase`'s loop), and `syncBase.ts` per the interfaces above.
- [ ] **Step 4: Run** the new spec, `hashDatabase.spec.ts`, `syncTables.spec.ts`, `syncColumns.spec.ts` — expect PASS; then the full checks from Global Constraints.
- [ ] **Step 5: Commit** `feat(sync): per-row hashes and a device-local sync base`.

### Task 2: The merge engine takes a change detector

**Files:**
- Create: `src/sync/changeDetection.ts`, `src/sync/__tests__/changeDetection.spec.ts`
- Modify: `src/sync/mergeEngine.ts`, `src/sync/__tests__/mergeTable.spec.ts`, `src/sync/__tests__/mergeDatabases.spec.ts` (and any other caller of `mergeTable` / `mergeDatabases`)

**Interfaces:**
- Consumes: `rowHash`, `RowHashes`, `BaseSource`, `snapshotDatabase`, `writeSyncBase` (Task 1); `changedSince` (`rows.ts`).
- Produces (`src/sync/changeDetection.ts`):
  - `interface ChangeDetector { changed(table: SyncTable, row: SyncRow): Promise<boolean>; readonly exact: boolean }` — `exact`: true when "neither side changed" is certain (decision 2).
  - `cutoffDetector(cutoff: string): ChangeDetector` — `changedSince`, `exact: false`.
  - `baseDetector(base: RowHashes): ChangeDetector` — changed ⇔ `rowHash(table, row) !== base.get(table.name)?.get(pk)` (a row absent from the base is changed), `exact: true`.
- Produces (`src/sync/mergeEngine.ts`):
  - `mergeTable(local, remote, table, changes: ChangeDetector): Promise<SyncConflict[]>`
  - `mergeDatabases(local: Database, remote: Database, changes: ChangeDetector, source?: BaseSource): Promise<SyncConflict[]>` — with `source`, writes the remote's snapshot as the new base (decision 4, first bullet) inside its transaction, after `recalculateBalances`. Take the remote snapshot before opening the local transaction (it reads only `remote`).

Hash only what is needed: `changed` is consulted only for rows that differ (`rowsEqual` already short-circuits equal rows).

- [ ] **Step 1: Write the failing tests** in `changeDetection.spec.ts` (two migrated databases, rows seeded directly, base built with `snapshotDatabase` of the "agreed" state):
  - with `baseDetector`, a row edited on one side only is taken from (or kept on) that side, with no conflict — **including when the edit's timestamps are older than any cutoff** (the bug);
  - a row edited on both sides is a conflict resolved by `resolveConflict` (a delete on one side wins and is reported);
  - a row absent from the base on both sides with different content is a conflict;
  - two tombstones of one tag with the same `deleted_at_utc` and different `parent_id`: no conflict, and swapping local and remote picks the same content;
  - `mergeDatabases(..., source)` leaves `readSyncBase(local)` equal to `snapshotDatabase(remote).rows` and the info naming `source` and the remote's database hash; when the merge throws (e.g. a foreign-key violation at commit), the base is unchanged.
- [ ] **Step 2: Run** them — expect FAIL.
- [ ] **Step 3: Implement** `changeDetection.ts`, switch `mergeTable` / `mergeDatabases` to `ChangeDetector`, add the neither-changed branch (decision 2) and the base write. Update existing tests mechanically: a cutoff string `c` becomes `cutoffDetector(c)`; existing expectations must not change.
- [ ] **Step 4: Run** the sync tests (`npx vitest run src/sync`) — expect PASS except the two `it.fails` in `cornerCases/cutoff.spec.ts` (still failing: the orchestrator does not use the base yet); then the full checks.
- [ ] **Step 5: Commit** `feat(sync): merge by change detector; base hashes or cutoff`.

### Task 3: The orchestrator uses the base; remotes have an identity

**Files:**
- Modify: `src/sync/SyncBackend.ts`, `src/sync/GitHubCsvBackend.ts`, `src/sync/GitHubTransport.ts`, `src/sync/SqliteBlobBackend.ts`, `src/sync/BlobTransport.ts`, `src/sync/S3Transport.ts`, `src/sync/SupabaseStorageTransport.ts`, `src/sync/syncOrchestrator.ts`, `src/sync/__tests__/fakes.ts`
- Modify tests: `src/sync/__tests__/cornerCases/cutoff.spec.ts`, `src/sync/__tests__/convergence.spec.ts`, `src/sync/__tests__/syncOrchestrator.spec.ts`, `src/sync/__tests__/backendFactory.spec.ts` (and transport specs for `remoteId`)

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `SyncBackend.remoteId: string` (decision 5); `FakeSyncBackend` takes an optional id (default `'memory'`).
  - `changeDetectorFor(db: SqlExecutor, source: BaseSource, lastKnown: RemoteState | null): Promise<ChangeDetector>` in `syncOrchestrator.ts` (exported for tests) — decision 3.
  - `runSync` follows decisions 3, 4 and 6: source = `{ remoteId: backend.remoteId, schemaVersion: localVersion }`; on success `saveLastKnown` first, then `writeSyncBase` in a `localDb.transaction`.

- [ ] **Step 1: Write / change the tests:**
  - `cutoff.spec.ts`: both `it.fails` become `it`; replace the "BUG … Deliberately failing" comments and the file header with what the scenarios now pin (a change made offline is seen as a change through the base). The control test stays.
  - `convergence.spec.ts` "after a lift whose deleted parent comes back": with real change detection B's delete of `d` and A's rename both changed `d`; delete wins, so `d` stays deleted, the discarded rename is reported, and `c` stays under `g`. Retitle ("…when the other device renames the deleted parent"), drop the "Relies on today's cutoff" comment, assert the new outcome.
  - `convergence.spec.ts` "after a redirect whose merged tag comes back": `x` stays merged (delete wins over the rename) and the transaction is tagged `y` on both devices. Retitle and assert that.
  - `cornerCases/merges.spec.ts` "keeps a restore when the other device merged the restored tag's parent": unchanged, must pass; also assert neither sync reports a conflict for `x`.
  - `syncOrchestrator.spec.ts`, new: the base is written after a first upload, an upload-local, a merge, and a `none` that finds no base for this remote (check `readSyncBaseInfo`: remote id, schema version, database hash = the uploaded metadata hash); a `none` with a matching info does not rewrite it.
  - `changeDetectorFor`: `exact` with a matching info; cutoff (`exact: false`) with no info, another remote id, or another schema version.
  - Two devices, new (in `cornerCases/cutoff.spec.ts` or a new `cornerCases/base.spec.ts`):
    - *provider switch to stale data*: after A has synced with remote one, A syncs with a backend of another `remoteId` whose copy of a row is older and different; A keeps its newer row (cutoff fallback);
    - *compare-and-swap retry keeps a restore*: B deletes T and uploads; A downloads that and merges; before A's upload lands, B restores T and uploads (inject it with `openWorld`'s `wrap`); A's retry keeps T live, and after settling both devices have T live;
    - *upgrade without a base*: delete A's `sync_base` / `sync_base_info` rows, then sync: the merge works (cutoff), and the info exists afterwards.
  - Backends / transports: `remoteId` per decision 5, no token or key in it.
- [ ] **Step 2: Run** `npx vitest run src/sync` — expect the new and flipped tests to FAIL.
- [ ] **Step 3: Implement** `remoteId` on transports, backends and fakes; `changeDetectorFor`; the `runSync` changes.
- [ ] **Step 4: Run** `npx vitest run` (whole suite) — expect PASS with no `it.fails` left in `cutoff.spec.ts`; then type-check and lint.
- [ ] **Step 5: Commit** `fix(sync): tell which side changed a row by its base hash`.

### Task 4: Documentation

**Files:**
- Modify: `docs/plans/2026-10-26-sync-change-detection.md`, `docs/scenarios/2026-05-22-database-sync-scenarios.md`, `CLAUDE.md`, `TASKS.md`

- [ ] **Step 1:** Change-detection doc: status line → "Built 2026-10-27 (option A)"; replace the "When implementing" list with a short "As built" section: the tombstone rule and why it replaced the merge-chain normalisation (decision 1), decisions 2–5 in a sentence each, and what is left — the base may be older than the upload (an app write between snapshot and export, or a crash between upload and base write), which over-reports changed rows for one sync and can, in that window only, let a delete win over a concurrent restore; blob uploads carry the device's `sync_base` tables along. Keep the problem/options sections as the record of the decision.
- [ ] **Step 2:** Scenarios doc: algorithm step 5 "Merge cutoff" becomes change detection by base hashes (with the cutoff as the fallback, and when); the conflict definition ("modified on both sides since the merge cutoff") becomes "changed on both sides since the last agreed state"; the base writes become part of the algorithm's steps where the upload succeeds.
- [ ] **Step 3:** CLAUDE.md: replace the "Known gap: …" sentence with how changes are detected (`src/sync/syncBase.ts`, `changeDetection.ts`, the doc link); add `sync_base` / `sync_base_info` to the device-local tables (the Per-device state bullet and the "Not on settings / migrations" note).
- [ ] **Step 4:** TASKS.md: remove the To Do entry "Sync: tell which side changed a row without timestamps"; add a Done line under a new "Sync — change detection" heading with the doc link. Check no other file still links to the removed entry (`grep -rn "tell which side changed" .` outside `node_modules`).
- [ ] **Step 5: Commit** `docs(sync): change detection by base hashes is built`.
