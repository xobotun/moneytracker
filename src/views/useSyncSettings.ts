import { ref, type Ref } from 'vue'
import type { Database } from '@/db/Database'
import type { SyncBackend } from '@/sync/SyncBackend'
import {
  getDeviceName,
  setDeviceName,
  loadLastKnownRemoteState,
  loadLastFetchedRemoteSnapshot,
  loadProviderConfig,
  saveProviderConfig,
  type ProviderConfig,
} from '@/sync/localState'
import type { RemoteState, SyncMetadata } from '@/sync/types'

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
  /** Backend used to hash the db. Null until the External-sync plan registers
   *  one — when null, the "Current local DB" row reads as unavailable in
   *  the UI. */
  backend: SyncBackend | null
}

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
}

export function useSyncSettings(deps: SyncSettingsDeps): SyncSettings {
  const deviceName = ref(getDeviceName())
  const lastKnownRemoteState = ref(loadLastKnownRemoteState())
  const lastFetchedRemoteSnapshot = ref(loadLastFetchedRemoteSnapshot())
  const providerConfig = ref<ProviderConfig>(loadProviderConfig())

  const localHash = ref<string | null>(null)
  const localHashComputedAt = ref<Date | null>(null)

  function saveDeviceNameNow(): void {
    setDeviceName(deviceName.value)
  }

  function saveProviderConfigNow(): void {
    saveProviderConfig(providerConfig.value)
  }

  async function recomputeLocalHash(): Promise<void> {
    if (!deps.db || !deps.backend) {
      // Backend absent → External-sync plan has not landed yet. Leave the
      // row null so the UI can render "not available".
      localHash.value = null
      localHashComputedAt.value = null
      return
    }
    // Each call hashes the database fresh. Cheap-ish for small DBs but
    // explicitly not run reactively on every keystroke — the composable
    // only computes when the caller asks for it (mount + Recompute button).
    localHash.value = await deps.backend.hashDatabase(deps.db)
    localHashComputedAt.value = new Date()
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
  }
}
