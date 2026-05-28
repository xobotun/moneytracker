import { describe, it, expect, beforeEach } from 'vitest'
import type { RemoteState, SyncMetadata } from '../../types'
import {
  loadLastKnownRemoteState,
  saveLastKnownRemoteState,
  loadLastFetchedRemoteSnapshot,
  saveLastFetchedRemoteSnapshot,
} from '../../localState/remoteSnapshots'

describe('remoteSnapshots', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('lastKnownRemoteState', () => {
    it('returns null when no remote state has been saved', () => {
      expect(loadLastKnownRemoteState()).toBeNull()
    })

    it('round-trips the last known remote state', () => {
      const state: RemoteState = {
        device: 'My laptop · a3f4b7e1',
        uploadedAtUtc: '2026-05-22T10:00:00.000Z',
        hash: 'abc',
      }
      saveLastKnownRemoteState(state)
      expect(loadLastKnownRemoteState()).toEqual(state)
    })
  })

  describe('lastFetchedRemoteSnapshot', () => {
    it('returns null when no snapshot has been cached', () => {
      expect(loadLastFetchedRemoteSnapshot()).toBeNull()
    })

    it('round-trips a snapshot', () => {
      const snap: SyncMetadata = {
        device: 'Office iMac · 7b22ee01',
        uploadedAtUtc: '2026-05-22T16:10:00.000Z',
        hash: 'd12af4',
        migrationVersion: 2,
      }
      saveLastFetchedRemoteSnapshot(snap)
      expect(loadLastFetchedRemoteSnapshot()).toEqual(snap)
    })

    it('save(null) clears the cache so loaders see "no remote connection" again', () => {
      const snap: SyncMetadata = {
        device: 'x',
        uploadedAtUtc: '2026-05-22T16:10:00.000Z',
        hash: 'h',
        migrationVersion: 2,
      }
      saveLastFetchedRemoteSnapshot(snap)
      saveLastFetchedRemoteSnapshot(null)
      expect(loadLastFetchedRemoteSnapshot()).toBeNull()
    })
  })
})
