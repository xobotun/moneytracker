import type { Database } from '../db/Database'
import type { RemoteState, SyncMetadata, SyncOutcome } from './types'
import { EPOCH_UTC } from './types'
import type { SyncBackend } from './SyncBackend'
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
    await deps.backend.tryUpload(localDb, meta, null)
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

    const remoteDb = await deps.backend.downloadDatabase()
    try {
      if (schemaAction === 'migrate-remote-then-merge') {
        await deps.migrate(remoteDb)
      }
      const cutoff = deps.loadLastKnown()?.uploadedAtUtc ?? EPOCH_UTC
      const conflicts = await mergeDatabases(localDb, remoteDb, cutoff)

      const finalHash = await deps.backend.hashDatabase(localDb)
      const meta = stamp(finalHash)

      const ok = await deps.backend.tryUpload(localDb, meta, expected)
      if (ok) {
        deps.saveLastKnown(remoteStateOf(meta))
        return { decision: 'merge', conflicts, uploaded: true }
      }
      // Another device uploaded during our merge — re-merge against the new remote.
      const fresh = await deps.backend.getMetadata()
      if (fresh === null) throw new Error('runSync: remote metadata disappeared mid-sync')
      expected = fresh
    } finally {
      await remoteDb.close()
    }
  }
}
