# Sqlite database sync scenarios

Every time the app is opened, we try to sync the database. 
The app itself is offline-first: it opens and is fully usable against the local SQLite database immediately. \
However, if the sync is requested (by user or automatically), it should block the UI to make sure the latest data is
always available. User may choose to interrupt the sync and continue working against local data.

## When sync runs

On app open, check network state:

- **No network** — don't sync. The app uses the local database.
- **Fast / unmetered network** (laptop on home wifi, etc.) — sync automatically when needed, per the scenarios below.
- **Metered / roaming network** — never sync automatically. Reliable roaming detection isn't available to a PWA, 
  so for now this is best-effort heuristic; it will be refined later. On Android/Windows only (no iOS to support).
- **Slow network, sync in progress** — expose a "use the local database" button
  so the user can dismiss the sync and keep working against local data.

A **manual "Sync now" button is always present in Settings**, regardless of
network state, so the user can force a sync. E.g. after interrupting the sync when on slow network.

## 1. No sync needed

A device opens the app and the remote database hash equals the local database hash. Nothing to do.

Rule: same hash → don't sync.

> A blob hash can differ after a `VACUUM` even when the data is semantically
> identical, causing an occasional needless sync. This is acceptable — this is a
> low-IOPS app, most opens fall under this case, and a redundant sync is cheap.

**First sync** (this device has no local database yet, or the remote has none)
is treated as this case: there is nothing to merge. Download the remote
wholesale, or — if the remote is empty — upload the local wholesale. No conflict
handling applies.

## 2. Sync needed

A device opens the app and the remote database hash differs from the local database hash.

Rule: hashes differ → check the last-uploading device and the timestamp.

Each device stores locally the **last known remote state** it last synced against:
`{ uploading device, upload timestamp, hash }`. This serves two purposes — it identifies who last touched the remote, 
and it is the baseline for the compare-and-swap upload (see the algorithm).

### 2.1. The last device to modify the remote is this current device

The remote contains no changes from any other device — it is just an older copy of what this device itself last uploaded. 
So, **no merge is needed**:

- If the local database has no new changes since that upload — do nothing.
- If the local database has new changes — upload the local database (it is a strict superset of the remote).

Timestamps are stored in UTC, so travelling across time zones is not a problem.
Because both the remote copy and the local copy were written by the *same* device, we only ever compare 
that one device's own clock against itself — cross-device clock skew is irrelevant here.
A 5-second epsilon covers minor clock drift; it does not need to cover long offline periods (e.g. a 4-hour
flight), because the device's own clock stays internally consistent throughout.

Rule: this device is the last uploader → no merge; upload local if it changed, otherwise do nothing.

### 2.2. The last device to modify the remote is a different device

The remote contains changes made by another device. 
A full row-level merge is required (see the algorithm below), regardless of timestamps.

Rule: remote last modified by a different device → always merge, then upload.

# Sync algorithm

Runs in the background after the app has opened. UI is temporarily blocked to show that the data merge is proceeding.
User may interrupt the sync at any time, the app will have to use the local database instead.

1. **Read remote metadata** (uploading device, upload timestamp, hash, migration version). Decide per the scenarios above.
    If scenario 1 — stop. If scenario 2.1 — upload local if changed, then stop. Otherwise continue.
2. Record the remote's current upload timestamp + hash as the **expected remote state** —
    this is the compare-and-swap baseline for the upload in step 8.
3. **Schema check.** The local database is always migrated to the app's current
   schema on startup. Compare the remote's migration version:
   - If the remote schema is **older**, download it and apply the pending
     migrations to the downloaded copy before merging.
   - If the remote schema is **newer** than this app supports, abort the sync
     and prompt the user to update the app.
4. **Download** the remote database to a temporary location and open it. Open the local database too.
5. **Change detection.** Decide per row which side changed since the last agreed state, by the
    **sync base**: the hash of every row as it stood when this device last agreed with the remote
    (device-local tables `sync_base` and `sync_base_info`). A row changed on a side when its hash
    differs from its base hash; a row the base lacks is new on the side that has it. No timestamps
    are compared. A deleted row hashes as its identity and delete time only.
    The base is used only when it was agreed with this remote and at this schema version. Otherwise
    (first sync, cleared site data, another provider, a migration since) fall back to the **merge
    cutoff**: the `upload timestamp` of the locally stored last known remote state; a row counts as
    changed when its `created_at_utc`, `updated_at_utc` or `deleted_at_utc` is newer than that.
    Over-including rows is harmless when only one side changed them.
6. **Merge, parent tables before child tables** so foreign keys (`ON DELETE RESTRICT`) are never violated mid-merge:
   1. tags and the tag side tables (location, merchant and journey details), and the other parent tables
      (applied rates, account groups); tags also reference each other, so foreign keys are checked at COMMIT
   2. accounts
   3. transactions
   For each row that differs between the two sides:
   - Changed on only one side → upsert it into the other side.
   - Changed on both sides → **conflict**, resolve per the section below.
   - There are no hard deletes — a deleted row is just a row with
     `deleted_at_utc` set, and the merge treats it like any other row.
7. Apply the merged result into the local database inside a **single atomic transaction**, 
    in the same parent-before-child order, so a crash cannot leave a half-merged database.
    Make the remote's rows the new base in the same transaction, after the tag repairs, so a retry
    in step 8 compares against the remote it just merged. Collect every conflicting row for the conflict email.
8. **Compare-and-swap upload.** Re-read the remote metadata:
   - If the remote's current upload timestamp + hash still equal the *expected remote state* from step 2 
     → upload the merged database, then overwrite the remote metadata with `{ this device, now, new hash, migration version }`.
     The hash is that of a snapshot of the local rows taken just before the upload.
   - If they differ, another device uploaded while we were merging. Discard the upload, update the expected remote state,
     and **go back to step 3** to re-merge against the new remote.

   Concurrent use by two devices is unlikely in practice, so this primitive CAS
   loop is sufficient; it just needs to never silently clobber a foreign upload.
9. Update the locally stored **last known remote state** to what we just uploaded, and make the
   snapshot taken before the upload the **sync base**. The same happens after an upload in scenario
   2.1 and after the first upload. In scenario 1 the local rows are the remote's: make them the base,
   unless the base already is that state. If writing the base fails, the sync reports an error and
   the next sync rewrites it. The base may be older than the upload (an app write in between), never
   newer: the next merge then over-reports changed rows once.

# Conflict resolution

A row is **in conflict** when it changed on *both* the local and the remote side since the last
agreed state (the sync base; the merge cutoff when there is none).
A conflict is reported once, by the device whose merge meets it. Two copies that still differ
although neither side changed (only possible with the base: two tombstones that differ in what the
hash leaves out) are settled the same way below, but not reported.

- If the two versions are byte-identical, it is not a real conflict — pick either.
- If one side deleted the row and the other updated it, **the delete wins** — keep the tombstone.
- Some rows outrank others whatever the timestamps (`ROW_RANK`). For tags: when both sides deleted the tag,
  a **merged tombstone wins over a plain delete** — it remembers where the tag's references go.
- Otherwise, the row with the latest `updated_at_utc` / `deleted_at_utc` wins.
- On an exact tie, the version whose content sorts greater wins (columns in name order, the merge's
  ignored columns left out), so every device picks the same one — never "local", which would let two
  devices keep their own copies forever.

Every conflicting row (the chosen winner and the discarded loser) is collected and included in an **email to the user** 
so the discarded change is never lost silently. Email sending is deferred — it needs a Supabase Edge Function and will
be implemented later.

> This is last-writer-wins at row granularity. It cannot tell apart "both
> devices edited different fields of the same row" from a true overwrite,
> because there is no stored common ancestor — that is an accepted limitation of
> the PoC. The conflict email is the safety net.

## Tag repairs

Taking each tag row whole from one side can combine changes into states no device produced. After the table
merge, in the same transaction, `repairTags` mends them in this order:

1. **Merge cycles** (X merged into Y on one device, Y into X on another) are broken by undoing the later merge:
   the tag with the latest `updated_at_utc` is restored from the side where it was live, stamped
   `max(the cycle's latest updated_at_utc + 1 ms, that row's updated_at_utc)`. Reported as `loop-undone`.
2. **References to merged tags** move to the end of each merge chain (transactions, accounts, the details
   tables, child tags). No timestamp is bumped.
3. **Categories in use** are restored: a deleted, unmerged category that a live transaction uses comes back from
   the side where it was live (or as its tombstone, when no side had it live), stamped
   `max(deleted_at_utc + 1 ms, that row's updated_at_utc)`. Reported as `delete-undone`.
4. **Children of deleted or merged tags** are lifted to the nearest live ancestor, or to the top level. No
   timestamp is bumped.
5. **Parent loops** are undone at the tag moved last (the greatest `moved_at_utc`, which only the user's moves
   set; ties: the greatest id): it goes back to its parent on the other side, or to the top level, and its
   `updated_at_utc` is bumped to now. Reported as `loop-undone`.

The stamps of steps 1 and 3 come from the rows, not the clock, and steps 2 and 4 keep timestamps, so every
device that meets the same state writes the same rows — including a device that restores another device's
restore again.

# Abstract sync provider API

The abstract sync provider grants read-write access to:

- the SQLite database blob
- which device last uploaded the database
- when the database was uploaded
- the hash of the database
- the latest migration version

It must support a **conditional (compare-and-swap) write**: "upload this database and metadata only 
if the current remote upload timestamp + hash still match the expected values; otherwise fail." 
This is what makes step 8 of the algorithm safe. Equivalent to an atomic git commit against an expected parent.

> Full-database upload/download is the PoC strategy. A future backend could do
> server-side row-level deduplication and conflict resolution; for now all of
> this logic runs on the handheld device.