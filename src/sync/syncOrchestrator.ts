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
