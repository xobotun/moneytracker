# Sync: Telling Which Side Changed a Row

**Status:** Postponed 2026-10-26. Known bug, pinned by two deliberately failing tests
(`it.fails`) in `src/sync/__tests__/cornerCases/cutoff.spec.ts`; tracked in TASKS.md as
"Sync: tell which side changed a row without timestamps". Found by the sync corner-case
tests of the tags-and-categories plan (Task A6).

---

## 1. The problem

During a merge, a device decides for every row whether it changed locally, remotely, or on
both sides. Today it decides by comparing the row's own edit timestamps with the time of
this device's last sync. A change made offline and uploaded later slips through.

| Minute | What happens |
|---|---|
| 1 | B, offline, deletes transaction T. The tombstone says `deleted_at_utc` = minute 1. |
| 3 | A syncs (uploads something unrelated). A's last sync is now minute 3. |
| 4 | B comes online: pulls A's upload, merges, pushes the delete. Correct so far. |
| 5 | A (not synced since minute 3) edits T. |
| 6 | A syncs and merges B's upload. Remote T was deleted at minute 1, before A's last sync, so it counts as **unchanged**; local T was edited at minute 5, so it counts as **changed**. "Only the local side moved" → A keeps its live T and uploads it. Delete-wins never runs; no conflict is reported. |
| 7 | B syncs (last sync minute 4). Remote T (edited at 5) counts as changed, its own tombstone (1) as unchanged → B takes the live T. **The delete is lost on both devices, silently.** |

The same path loses a manual exchange rate: B types a manual EUR/USD rate offline, A's
resolver later upgrades its own row of that day to an ECB rate; the override — which
`ROW_RANK` promises is never lost to a resolver — disappears on both devices.

It happens with perfectly synchronised clocks; it is not the "clock skew" item.

What the scenarios doc (`docs/scenarios/2026-05-22-database-sync-scenarios.md`) expects:
both sides changed T since they last agreed, so it is a conflict — the delete wins, and the
discarded edit is reported.

## 2. How sync decides today

1. **Whole-database hash** (`hashDatabase`: canonical JSON of every row, SHA-256) plus
   metadata `{ device, uploadedAtUtc, hash, migrationVersion }` decide whether to sync at all:
   equal hashes → nothing; this device uploaded last → upload; otherwise → merge.
2. **Merge cutoff** (`syncOrchestrator.ts`): `cutoff = lastKnown.uploadedAtUtc` — the upload
   time of this device's last successful sync.
3. **Per row** (`rows.ts` `changedSince`): changed ⇔ `created_at_utc`, `updated_at_utc` or
   `deleted_at_utc` > cutoff. Changed on one side → take it; on both → `resolveConflict`
   (delete wins → rank → newer timestamp → tie by content).
4. **Compare-and-swap upload**: re-merge if another device uploaded meanwhile.

## 3. Why these mechanisms do not catch it

- **The cutoff mixes two clocks.** A row's timestamp says when it was *edited*; the cutoff
  says when this device *last saw the remote*. An edit made offline reaches the remote
  later than it was made, so it can predate another device's cutoff although that device
  has never seen it. The scenarios doc's argument "one device's clock compared with itself"
  is true for scenario 2.1 (this device uploaded last), not for 2.2 (merging a foreign upload).
- **The database hash is all-or-nothing.** It says the two databases differ, not which rows
  differ, and not which side moved.
- **Compare-and-swap** protects the upload from clobbering a foreign upload; it says nothing
  about which side changed a row.
- **Git history is not used.** The GitHub backend pins the HEAD commit it read (for
  compare-and-swap and unchanged-file detection) but never reads the commit this device
  last synced against. The Supabase / S3 backends keep no history at all.

Consequences beyond the two tests: every "both sides changed" case where one side's edit
predates the other device's cutoff is treated as one-sided. Delete-wins and rank rules are
skipped (the outcome changes), and for plain edits the outcome is usually the same
(latest wins anyway) but the discarded edit is never reported.

## 4. Options

### A. Per-row base hashes — recommended

Keep, per device, the hash of every row as of the last state both sides agreed on (what
this device last uploaded or accepted). A device-local table, e.g.
`sync_base(table_name, pk, row_hash)`, excluded from sync like `settings`, rewritten after
every successful sync from the database that was uploaded.

During a merge: changed locally ⇔ `hash(local row) ≠ base`; changed remotely ⇔
`hash(remote row) ≠ base`; a row absent from the base is new on the side that has it.
Then the existing rules decide (delete wins → rank → newer → tie by content).

- **Upsides**
  - No clocks in change detection: late uploads, offline periods and clock skew stop mattering.
  - The same for all three providers; no network or history needed.
  - Small: one short hash per row (a 16-byte truncated SHA-256 ≈ 10 000 rows → ~0.3 MB).
  - Reuses the canonical row serialisation `hashDatabase` already has (derived / ignored
    columns left out the same way).
  - Every real conflict is detected, so the conflict report (and the planned conflict
    email) becomes complete.
- **Downsides**
  - New device-local state that must match the remote: written only after a successful
    compare-and-swap. If the app dies between the upload and the base write, the next sync
    compares against an older base — it then over-reports "changed" rows, which the
    conflict rules resolve; safe, but may show spurious conflicts once.
  - No base on the first sync after install, after clearing site data, or when switching
    provider: fall back to today's cutoff for that one sync.
  - One more pass over all rows per sync to hash them (the database hash already does one;
    they can share it).
  - Rewrites without a timestamp bump make a row differ from the other device's base
    although nobody edited it: the sync repairs' redirect and lift (`bump: false`), and the
    user's merge on tombstones (a merge does not bump deleted rows, `src/db/tagReferences.ts`).
    Counted as changes they are not harmless: a rewritten tombstone meets a concurrent
    restore on the other device as "changed on both sides", and delete-wins drops the
    restore (`src/sync/__tests__/cornerCases/merges.spec.ts`, "keeps a restore when the other
    device merged the restored tag's parent"). So option A must not count them: compare rows
    normalised through the merge-chain map (apply the redirects to the base hashes and to the
    current rows alike), or record the repairs' rewrites in the base. A lift is no merge
    chain: it needs the second way, or the same normalisation over deleted parents.

### B. Full base copy (three-way merge)

Keep the whole database as it was at the last sync (a second SQLite file locally, or, for
GitHub only, download the commit this device last synced against).

- **Upsides**
  - Exact three-way merge; also opens **column-level merging** later: A renames a tag while
    B changes its colour → both survive, instead of one losing the whole row.
- **Downsides**
  - Doubles local storage (IndexedDB), or extra downloads (GitHub); Supabase / S3 have no
    history unless bucket versioning is enabled, so they need the local copy anyway.
  - More code than A for the same row-level result; column-level merging is a new rule set
    of its own.

### C. Per-row version counters

Each row carries a counter (or a Lamport clock / version vector) incremented on every local
write; the base is "counter values at the last sync".

- **Upsides**
  - The textbook approach; no base data beyond counters.
- **Downsides**
  - A new column on every synced table (schema, `SYNC_COLUMNS`, CSV), and every repository
    write, merge, repair and cache refresh must maintain it — easy to forget one path.
  - For two or three household devices it buys nothing over A.

### D. Keep timestamps, move the cutoff further back

E.g. cutoff = last sync − 7 days, or the oldest upload time any device reported.

- **Upsides**
  - A one-line change.
- **Downsides**
  - Not a fix: an offline period longer than the margin still loses changes.
  - Over-including rows on both sides creates false conflicts with wrong outcomes: a delete
    synced long ago meets a later restore on the other device → both look "changed" →
    delete wins → **the restore is lost**. Today's "over-including is harmless" holds only
    for rows changed on one side.

## 5. Recommendation

Option A, with today's cutoff as the fallback when no base exists. Consider B later only if
column-level merging becomes a goal.

When implementing:
- Flip the two `it.fails` in `cutoff.spec.ts` to `it`, and revisit two `convergence.spec.ts`
  tests that rely on today's cutoff: "after a redirect whose merged tag comes back" (a live
  row winning over an older remote merge) and "after a lift whose deleted parent comes back"
  (A's rename of d wins only because B's tombstone of d predates A's cutoff; with real change
  detection both sides changed d, delete-wins keeps it deleted, and the test's last
  assertion flips).
- Keep `cornerCases/merges.spec.ts` "keeps a restore when the other device merged the
  restored tag's parent" passing: it fails if the rewrites without a timestamp bump count as
  changes (see option A's downsides).
- Update the scenarios doc (algorithm step 5, "Merge cutoff"; conflict definition).
- Remove the TASKS.md entry.
