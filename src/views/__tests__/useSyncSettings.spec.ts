import { describe, it, expect, beforeEach } from 'vitest'
import { useSyncSettings } from '../useSyncSettings'
import { Database } from '../../db/Database'
import type { SyncBackend } from '../../sync/SyncBackend'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { FakeSyncBackend } from '../../sync/__tests__/fakes'
import {
  saveLastKnownRemoteState,
  saveLastFetchedRemoteSnapshot,
  EMPTY_PROVIDER_CONFIG,
  loadProviderConfig,
  getDeviceName,
  saveSyncError,
  loadSyncError,
} from '../../sync/localState'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

// A minimal backend stub — only the method the composable uses.
function fakeBackend(hash: string): SyncBackend {
  return {
    getMetadata: async () => null,
    downloadDatabase: async () => {
      throw new Error('not used here')
    },
    hashDatabase: async () => hash,
    tryUpload: async () => true,
  }
}

// `null as unknown as Database` only goes through the composable when the
// backend is also null — exercised below in the "DB unavailable" test.
const NO_DB = null as unknown as Database | null

describe('useSyncSettings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('device name', () => {
    it('exposes the persisted device name and updates the underlying store on save', () => {
      const s = useSyncSettings({ db: NO_DB, backend: null })
      // Default minted on first read.
      expect(s.deviceName.value).toMatch(/^.+ on .+ · [0-9a-f]{8}$/)

      s.deviceName.value = 'My laptop'
      s.saveDeviceName()
      expect(getDeviceName()).toBe('My laptop')
    })
  })

  describe('last sync row', () => {
    it('reports "never" when no sync has happened', () => {
      const s = useSyncSettings({ db: NO_DB, backend: null })
      expect(s.lastKnownRemoteState.value).toBeNull()
    })

    it('returns the persisted lastKnownRemoteState', () => {
      saveLastKnownRemoteState({
        device: 'My laptop · a3f4b7e1',
        uploadedAtUtc: '2026-05-22T10:00:00.000Z',
        hash: 'abc',
      })
      const s = useSyncSettings({ db: NO_DB, backend: null })
      expect(s.lastKnownRemoteState.value).toEqual({
        device: 'My laptop · a3f4b7e1',
        uploadedAtUtc: '2026-05-22T10:00:00.000Z',
        hash: 'abc',
      })
    })
  })

  describe('current local DB row', () => {
    it('is null when no backend is available', async () => {
      const s = useSyncSettings({ db: NO_DB, backend: null })
      await s.recomputeLocalHash()
      expect(s.localHash.value).toBeNull()
      expect(s.localHashComputedAt.value).toBeNull()
    })

    it('computes the hash on demand and stores the computation time', async () => {
      const backend = fakeBackend('cafef00d')
      const fakeDb = {} as Database // backend.hashDatabase never touches the db in the fake
      const s = useSyncSettings({ db: fakeDb, backend })
      const before = Date.now()
      await s.recomputeLocalHash()
      expect(s.localHash.value).toBe('cafef00d')
      const at = s.localHashComputedAt.value
      expect(at).not.toBeNull()
      expect(at!.getTime()).toBeGreaterThanOrEqual(before)
    })
  })

  describe('last seen remote row', () => {
    it('reports null when no snapshot has been cached', () => {
      const s = useSyncSettings({ db: NO_DB, backend: null })
      expect(s.lastFetchedRemoteSnapshot.value).toBeNull()
    })

    it('returns the cached snapshot', () => {
      saveLastFetchedRemoteSnapshot({
        device: 'Office iMac · 7b22ee01',
        uploadedAtUtc: '2026-05-22T16:10:00.000Z',
        hash: 'd12af4',
        migrationVersion: 2,
      })
      const s = useSyncSettings({ db: NO_DB, backend: null })
      expect(s.lastFetchedRemoteSnapshot.value?.device).toBe('Office iMac · 7b22ee01')
    })
  })

  describe('provider config', () => {
    it('exposes EMPTY_PROVIDER_CONFIG when nothing is stored', () => {
      const s = useSyncSettings({ db: NO_DB, backend: null })
      expect(s.providerConfig.value).toEqual(EMPTY_PROVIDER_CONFIG)
    })

    it('saves edits to the underlying provider-config store', () => {
      const s = useSyncSettings({ db: NO_DB, backend: null })
      s.providerConfig.value.active = 's3'
      s.providerConfig.value.s3.bucket = 'my-bucket'
      s.saveProviderConfig()
      const reloaded = loadProviderConfig()
      expect(reloaded.active).toBe('s3')
      expect(reloaded.s3.bucket).toBe('my-bucket')
    })
  })
})

describe('useSyncSettings — syncNow + lastSyncError', () => {
  beforeEach(() => localStorage.clear())

  it('exposes syncing = false initially', () => {
    const s = useSyncSettings({ db: null, backend: null })
    expect(s.syncing.value).toBe(false)
  })

  it('exposes lastSyncError loaded from localState', () => {
    saveSyncError({ atUtc: '2026-05-28T10:00:00.000Z', message: 'Auth failed' })
    const s = useSyncSettings({ db: null, backend: null })
    expect(s.lastSyncError.value?.message).toBe('Auth failed')
  })

  it('syncNow toggles syncing during the call', async () => {
    const db = await migratedDb()
    const backend = new FakeSyncBackend()
    const s = useSyncSettings({ db, backend })
    const p = s.syncNow()
    expect(s.syncing.value).toBe(true)
    await p
    expect(s.syncing.value).toBe(false)
    await db.close()
    await backend.close()
  })

  it('syncNow clears lastSyncError on success', async () => {
    saveSyncError({ atUtc: '2026-05-28T10:00:00.000Z', message: 'old' })
    const db = await migratedDb()
    const backend = new FakeSyncBackend()
    const s = useSyncSettings({ db, backend })
    await s.syncNow()
    expect(s.lastSyncError.value).toBeNull()
    expect(loadSyncError()).toBeNull()
    await db.close()
    await backend.close()
  })

  it('syncNow records an error when the backend throws', async () => {
    const db = await migratedDb()
    const failingBackend = {
      getMetadata: async () => {
        throw new Error('boom')
      },
      downloadDatabase: async () => {
        throw new Error('boom')
      },
      hashDatabase: async () => 'sha256:0',
      tryUpload: async () => false,
    }
    const s = useSyncSettings({ db, backend: failingBackend })
    await s.syncNow()
    expect(s.lastSyncError.value?.message).toMatch(/boom/)
    await db.close()
  })

  it('syncNow is a no-op when no backend is registered', async () => {
    const db = await migratedDb()
    const s = useSyncSettings({ db, backend: null })
    await s.syncNow()
    expect(s.syncing.value).toBe(false)
    expect(s.lastSyncError.value).toBeNull()
    await db.close()
  })
})
