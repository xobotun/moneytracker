import type { Database } from '../db/Database'
import type { RemoteState, SyncMetadata, SyncOutcome } from './types'
import { EPOCH_UTC } from './types'
import type { SyncBackend } from './SyncBackend'
import { readSchemaVersion, decideSchemaAction } from './schemaVersion'
import { mergeDatabases } from './mergeEngine'
import { cutoffDetector } from './changeDetection'

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
 * Mutates `localDb` in place when a merge happens. The caller closes `localDb`.
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

  const stamp = (hash: string): SyncMetadata => ({
    device: deps.deviceName,
    uploadedAtUtc: deps.now().toISOString(),
    hash,
    migrationVersion: localVersion,
  })

  // First sync — the remote has no database yet. Nothing to merge; upload local.
  if (remoteMeta === null) {
    const meta = stamp(localHash)
    // Another device's first upload may win the race; then there is a remote
    // to merge, and recording `meta` as the baseline would be a lie.
    const ok = await deps.backend.tryUpload(localDb, meta, null)
    if (!ok) return CAS_MISS
    deps.saveLastKnown(remoteStateOf(meta))
    return { decision: 'first-sync-upload', conflicts: [], uploaded: true }
  }

  const decision = decideSync(localHash, remoteMeta, deps.deviceName)

  // Scenario 1 — databases already identical.
  if (decision === 'none') {
    deps.saveLastKnown(remoteStateOf(remoteMeta))
    return { decision: 'none', conflicts: [], uploaded: false }
  }

  // Scenario 2.1 — this device was the last uploader; remote has nothing
  // foreign, so just upload the local database.
  if (decision === 'upload-local') {
    const meta = stamp(localHash)
    const ok = await deps.backend.tryUpload(localDb, meta, remoteMeta)
    if (!ok) return CAS_MISS // remote moved underneath us; next attempt will merge it
    deps.saveLastKnown(remoteStateOf(meta))
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
    const cutoff = deps.loadLastKnown()?.uploadedAtUtc ?? EPOCH_UTC
    const conflicts = await mergeDatabases(localDb, remoteDb, cutoffDetector(cutoff))

    const finalHash = await deps.backend.hashDatabase(localDb)
    const meta = stamp(finalHash)

    const ok = await deps.backend.tryUpload(localDb, meta, remoteMeta)
    if (!ok) return CAS_MISS // another device uploaded during our merge; re-merge next attempt
    deps.saveLastKnown(remoteStateOf(meta))
    return { decision: 'merge', conflicts, uploaded: true }
  } finally {
    await remoteDb.close()
  }
}
