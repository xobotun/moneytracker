import { computed, ref, toValue, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import type { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import type { SyncBackend } from '@/sync/SyncBackend'
import {
  getDeviceName,
  setDeviceName,
  loadLastKnownRemoteState,
  saveLastKnownRemoteState,
  loadLastFetchedRemoteSnapshot,
  loadProviderConfig,
  saveProviderConfig,
  loadSyncError,
  saveSyncError,
  clearSyncError,
  type ProviderConfig,
  type SyncError,
} from '@/sync/localState'
import { runSync } from '@/sync/syncOrchestrator'
import type { RemoteState, SyncMetadata, SyncOutcome } from '@/sync/types'

// Composable for the Sync sections of the Settings page. Owns the reactive
// state and the localStorage writes; the .vue file is presentation-only.
//
// Dependencies (database + backend) are passed in explicitly rather than read
// from a module-level singleton inside this function. Two reasons:
//   1. Tests stay trivial — just call useSyncSettings({db, backend}) with fakes.
//   2. The backend is legitimately absent today (the External-sync plan is what
//      registers a real one). Making absence visible in the call signature
//      forces callers to think about it.

export interface SyncSettingsDeps {
  /** Local database used to compute the current-local-DB hash. May be null
   *  when called from a non-db test fixture. */
  db: Database | null
  /** Backend used to hash and sync the db; null when no provider is
   *  configured. Pass a ref (or getter) to follow the live registry: the
   *  value is read on every use, so switching providers takes effect
   *  without a reload. A plain value is fine for tests. */
  backend: MaybeRefOrGetter<SyncBackend | null>
  /** Called after the provider config is saved. Production wires this to
   *  rebuild and re-register the backend from the new config. */
  onProviderConfigSaved?: (cfg: ProviderConfig) => void
}

/** What the last successful "Sync now" did, for display. */
export interface LastSyncOutcome {
  atUtc: string
  decision: SyncOutcome['decision']
  conflicts: number
  uploaded: boolean
}

// Module scope, not per composable instance: navigating away from Settings
// and back creates a new instance while the old sync may still be running.
// A per-instance flag would let the new instance start a second, parallel
// sync against the same database.
const syncing = ref(false)

export interface SyncSettings {
  // Device name — editable.
  deviceName: Ref<string>
  saveDeviceName: () => void

  // Read-only displays.
  lastKnownRemoteState: Ref<RemoteState | null>
  lastFetchedRemoteSnapshot: Ref<SyncMetadata | null>

  // Computed on demand. `localHash` is null when the codec is unavailable
  // OR when recomputeLocalHash has not been called yet.
  localHash: Ref<string | null>
  localHashComputedAt: Ref<Date | null>
  recomputeLocalHash: () => Promise<void>

  // Provider config — editable through the reactive ref, persisted on save.
  providerConfig: Ref<ProviderConfig>
  saveProviderConfig: () => void

  // Sync-now flow.
  /** True while a backend is registered (follows provider switches). */
  backendAvailable: ComputedRef<boolean>
  syncing: Ref<boolean>
  lastSyncError: Ref<SyncError | null>
  lastSyncOutcome: Ref<LastSyncOutcome | null>
  syncNow: () => Promise<void>
}

export function useSyncSettings(deps: SyncSettingsDeps): SyncSettings {
  const deviceName = ref(getDeviceName())
  const lastKnownRemoteState = ref(loadLastKnownRemoteState())
  const lastFetchedRemoteSnapshot = ref(loadLastFetchedRemoteSnapshot())
  const providerConfig = ref<ProviderConfig>(loadProviderConfig())

  const localHash = ref<string | null>(null)
  const localHashComputedAt = ref<Date | null>(null)

  const lastSyncError = ref<SyncError | null>(loadSyncError())
  const lastSyncOutcome = ref<LastSyncOutcome | null>(null)
  const backendAvailable = computed(() => toValue(deps.backend) !== null)

  function saveDeviceNameNow(): void {
    setDeviceName(deviceName.value)
  }

  function saveProviderConfigNow(): void {
    saveProviderConfig(providerConfig.value)
    // Pass a fresh copy of what was stored, never the form's reactive object:
    // transports keep the config they are built with, so sharing it would let
    // unsaved keystrokes (a half-typed token) reach a running sync.
    deps.onProviderConfigSaved?.(loadProviderConfig())
  }

  function recordSyncError(message: string): void {
    const err: SyncError = { atUtc: new Date().toISOString(), message }
    saveSyncError(err)
    lastSyncError.value = err
  }

  async function recomputeLocalHash(): Promise<void> {
    const backend = toValue(deps.backend)
    if (!deps.db || !backend) {
      // Backend absent → External-sync plan has not landed yet. Leave the
      // row null so the UI can render "not available".
      localHash.value = null
      localHashComputedAt.value = null
      return
    }
    // Each call hashes the database fresh. Cheap-ish for small DBs but
    // explicitly not run reactively on every keystroke — the composable
    // only computes when the caller asks for it (mount + Recompute button).
    localHash.value = await backend.hashDatabase(deps.db)
    localHashComputedAt.value = new Date()
  }

  async function syncNow(): Promise<void> {
    const backend = toValue(deps.backend)
    if (!deps.db || !backend) return
    if (syncing.value) return
    syncing.value = true
    try {
      const outcome = await runSync(deps.db, {
        backend,
        deviceName: deviceName.value,
        now: () => new Date(),
        migrate: (remote) => runMigrations(remote, ALL_MIGRATIONS),
        loadLastKnown: loadLastKnownRemoteState,
        saveLastKnown: saveLastKnownRemoteState,
      })
      if (outcome.decision === 'aborted-app-outdated') {
        // runSync returns normally here, but nothing was merged or uploaded.
        recordSyncError(
          'Sync stopped: the remote database was written by a newer version of the app. Update this app (reload the page) and sync again.',
        )
        return
      }
      clearSyncError()
      lastSyncError.value = null
      lastSyncOutcome.value = {
        atUtc: new Date().toISOString(),
        decision: outcome.decision,
        conflicts: outcome.conflicts.length,
        uploaded: outcome.uploaded,
      }
      // Refresh displayed snapshots on success.
      lastKnownRemoteState.value = loadLastKnownRemoteState()
      await recomputeLocalHash()
    } catch (e) {
      recordSyncError(e instanceof Error ? e.message : String(e))
    } finally {
      syncing.value = false
    }
  }

  return {
    deviceName,
    saveDeviceName: saveDeviceNameNow,
    lastKnownRemoteState,
    lastFetchedRemoteSnapshot,
    localHash,
    localHashComputedAt,
    recomputeLocalHash,
    providerConfig,
    saveProviderConfig: saveProviderConfigNow,
    backendAvailable,
    syncing,
    lastSyncError,
    lastSyncOutcome,
    syncNow,
  }
}
