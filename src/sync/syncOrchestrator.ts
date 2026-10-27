import type { Database, SqlExecutor } from '../db/Database'
import type { RemoteState, SyncMetadata, SyncOutcome } from './types'
import { EPOCH_UTC } from './types'
import type { SyncBackend } from './SyncBackend'
import { readSchemaVersion, decideSchemaAction } from './schemaVersion'
import { mergeDatabases } from './mergeEngine'
import { baseDetector, cutoffDetector, type ChangeDetector } from './changeDetection'
import {
  hashRows,
  readSyncBase,
  readSyncBaseInfo,
  readSyncedRows,
  writeSyncBase,
  type BaseSource,
} from './syncBase'

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
  deviceName: string,
): SyncDecision {
  if (localHash === remoteMeta.hash) return 'none'
  if (remoteMeta.device === deviceName) return 'upload-local'
  return 'merge'
}

/**
 * How the merge tells which side changed a row: by the sync base when this
 * device has one agreed with this remote at this schema version, otherwise by
 * the cutoff of the last sync. A base from another remote describes another
 * history (a stale remote's old rows would look changed, and win), and a
 * migration changes the hash of every row.
 */
export async function changeDetectorFor(
  db: SqlExecutor,
  source: BaseSource,
  lastKnown: RemoteState | null,
): Promise<ChangeDetector> {
  const info = await readSyncBaseInfo(db)
  if (info?.remoteId === source.remoteId && info.schemaVersion === source.schemaVersion) {
    return baseDetector(await readSyncBase(db))
  }
  return cutoffDetector(lastKnown?.uploadedAtUtc ?? EPOCH_UTC)
}

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
  /** How many times to try before giving up when other devices keep winning the upload race. Default 5. */
  maxAttempts?: number
  /** Waits between attempts — injectable so tests don't sleep. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 1000

/** Returned by one attempt when the compare-and-swap upload lost to another device. */
const CAS_MISS = Symbol('cas-miss')

function remoteStateOf(meta: SyncMetadata): RemoteState {
  return { device: meta.device, uploadedAtUtc: meta.uploadedAtUtc, hash: meta.hash }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs the full sync algorithm (see docs/scenarios/2026-05-22-database-sync-scenarios.md).
 * Mutates `localDb` in place when a merge happens, and keeps its sync base
 * (syncBase.ts): the state this device last agreed on with the remote. The
 * caller closes `localDb`.
 *
 * When another device uploads between our read and our compare-and-swap, the
 * attempt is retried from scratch (re-read the remote, re-decide, re-merge),
 * with exponential backoff, at most `maxAttempts` times. The bound matters: a
 * backend that keeps answering "conflict" (e.g. a stale HTTP cache, or a
 * non-CAS error mapped to a CAS miss) would otherwise loop forever and hammer
 * the provider.
 */
export async function runSync(localDb: Database, deps: SyncDeps): Promise<SyncOutcome> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const sleep = deps.sleep ?? defaultSleep
  for (let attempt = 1; ; attempt++) {
    const outcome = await attemptSync(localDb, deps)
    if (outcome !== CAS_MISS) return outcome
    if (attempt >= maxAttempts) {
      throw new Error(
        `runSync: the remote kept changing during sync; gave up after ${maxAttempts} attempts`,
      )
    }
    // Exponential backoff plus up to 50% jitter, so two devices racing each
    // other don't retry in lockstep.
    const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1)
    await sleep(delay * (1 + Math.random() * 0.5))
  }
}

/** One pass of the algorithm. Returns CAS_MISS when the upload lost a race. */
async function attemptSync(
  localDb: Database,
  deps: SyncDeps,
): Promise<SyncOutcome | typeof CAS_MISS> {
  const localVersion = await readSchemaVersion(localDb)
  const localHash = await deps.backend.hashDatabase(localDb)
  const remoteMeta = await deps.backend.getMetadata()
  // What a base written by this sync is agreed with.
  const source: BaseSource = { remoteId: deps.backend.remoteId, schemaVersion: localVersion }

  /**
   * Compare-and-swap upload of the local database. On success the uploaded
   * rows become the last-known remote state and the sync base. The rows are
   * read before the upload, so the base may be older than what was uploaded
   * (an app write landing in between), never newer; the stamp carries their
   * hash. Only the read and that hash come before the upload, to keep the
   * window short: the rows' own hashes are computed after it, from the same
   * rows.
   */
  const upload = async (expected: SyncMetadata | null): Promise<boolean> => {
    const read = await readSyncedRows(localDb)
    const meta: SyncMetadata = {
      device: deps.deviceName,
      uploadedAtUtc: deps.now().toISOString(),
      hash: read.databaseHash,
      migrationVersion: localVersion,
    }
    if (!(await deps.backend.tryUpload(localDb, meta, expected))) return false
    deps.saveLastKnown(remoteStateOf(meta))
    const snapshot = await hashRows(read)
    await localDb.transaction((tx) => writeSyncBase(tx, snapshot, source))
    return true
  }

  // First sync — the remote has no database yet. Nothing to merge; upload local.
  if (remoteMeta === null) {
    // Another device's first upload may win the race; then there is a remote
    // to merge, and recording ours as the baseline would be a lie.
    if (!(await upload(null))) return CAS_MISS
    return { decision: 'first-sync-upload', conflicts: [], uploaded: true }
  }

  const decision = decideSync(localHash, remoteMeta, deps.deviceName)

  // Scenario 1 — databases already identical.
  if (decision === 'none') {
    deps.saveLastKnown(remoteStateOf(remoteMeta))
    await adoptAsBase(localDb, source, remoteMeta.hash)
    return { decision: 'none', conflicts: [], uploaded: false }
  }

  // Scenario 2.1 — this device was the last uploader; remote has nothing
  // foreign, so just upload the local database.
  if (decision === 'upload-local') {
    if (!(await upload(remoteMeta))) return CAS_MISS // remote moved underneath us; next attempt will merge it
    return { decision: 'upload-local', conflicts: [], uploaded: true }
  }

  // Scenario 2.2 — merge a foreign upload, then compare-and-swap the result.
  const schemaAction = decideSchemaAction(localVersion, remoteMeta.migrationVersion)
  if (schemaAction === 'abort-app-outdated') {
    return { decision: 'aborted-app-outdated', conflicts: [], uploaded: false }
  }

  const remoteDb = await deps.backend.downloadDatabase()
  try {
    if (schemaAction === 'migrate-remote-then-merge') {
      await deps.migrate(remoteDb)
    }
    const changes = await changeDetectorFor(localDb, source, deps.loadLastKnown())
    // The merge also makes the remote's rows the base: should the upload
    // lose the race, the next attempt compares with the remote it merged.
    const conflicts = await mergeDatabases(localDb, remoteDb, changes, source)

    if (!(await upload(remoteMeta))) return CAS_MISS // another device uploaded during our merge; re-merge next attempt
    return { decision: 'merge', conflicts, uploaded: true }
  } finally {
    await remoteDb.close()
  }
}

/**
 * When nothing needed syncing, the local rows are the remote's: make them the
 * base, so the next merge can tell which side changed a row — unless the base
 * already is that state. The rows are read and hashed again, and written only
 * if they still are the remote's: an app write may have landed since the hash
 * that found nothing to sync.
 */
async function adoptAsBase(
  localDb: Database,
  source: BaseSource,
  remoteHash: string,
): Promise<void> {
  const info = await readSyncBaseInfo(localDb)
  if (
    info?.remoteId === source.remoteId &&
    info.schemaVersion === source.schemaVersion &&
    info.databaseHash === remoteHash
  ) {
    return
  }
  const read = await readSyncedRows(localDb)
  if (read.databaseHash !== remoteHash) return
  const snapshot = await hashRows(read)
  await localDb.transaction((tx) => writeSyncBase(tx, snapshot, source))
}
