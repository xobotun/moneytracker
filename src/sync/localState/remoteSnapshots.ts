import type { RemoteState, SyncMetadata } from '../types'
import { nullableJsonStore } from './storage'

// Two snapshot slots, both produced by the sync subsystem and consumed by the
// Settings UI as read-only displays:
//
//  - lastKnownRemoteState     — the orchestrator writes this after every
//                               successful sync. Used by the merge cutoff and
//                               displayed in Settings as "Last sync (this device)".
//
//  - lastFetchedRemoteSnapshot — populated by the future app-launch fetch
//                               (deferred to the External-sync plan). Settings
//                               reads only the cache; it never triggers a
//                               network call. Until the fetch is wired in, the
//                               slot stays empty and Settings shows
//                               "no remote connection".

const lastKnown = nullableJsonStore<RemoteState>('lastKnownRemoteState')
const lastFetched = nullableJsonStore<SyncMetadata>('lastFetchedRemoteSnapshot')

/** The remote state recorded at the last successful sync, or null if never synced. */
export function loadLastKnownRemoteState(): RemoteState | null {
  return lastKnown.load()
}

/** Persists the remote state to compare against on the next sync. */
export function saveLastKnownRemoteState(state: RemoteState): void {
  lastKnown.save(state)
}

/** The most recent remote metadata fetched outside of a sync, or null when none. */
export function loadLastFetchedRemoteSnapshot(): SyncMetadata | null {
  return lastFetched.load()
}

/** Persists a fetched remote snapshot for the Settings UI. Pass null to clear. */
export function saveLastFetchedRemoteSnapshot(snapshot: SyncMetadata | null): void {
  lastFetched.save(snapshot)
}
