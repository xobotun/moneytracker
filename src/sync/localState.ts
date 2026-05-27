import { newId } from '../db/uuid'
import type { RemoteState } from './types'

// Sync bookkeeping is stored in localStorage, NOT in the SQLite database.
// The whole database is uploaded as one blob, so anything in a SQLite table
// would be carried to every other device. The device id must stay unique
// per device, so it must live outside the synced data.

const DEVICE_ID_KEY = 'moneytracker.sync.deviceId'
const REMOTE_STATE_KEY = 'moneytracker.sync.lastKnownRemoteState'

/** Returns this device's stable id, minting and persisting one on first call. */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = newId()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

/** The remote state recorded at the last successful sync, or null if never synced. */
export function loadLastKnownRemoteState(): RemoteState | null {
  const raw = localStorage.getItem(REMOTE_STATE_KEY)
  return raw ? (JSON.parse(raw) as RemoteState) : null
}

/** Persists the remote state to compare against on the next sync. */
export function saveLastKnownRemoteState(state: RemoteState): void {
  localStorage.setItem(REMOTE_STATE_KEY, JSON.stringify(state))
}
