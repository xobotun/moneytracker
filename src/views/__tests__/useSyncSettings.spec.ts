import { describe, it, expect, beforeEach, vi } from 'vitest'
import { shallowRef } from 'vue'
import { useSyncSettings } from '../useSyncSettings'
import { Database } from '../../db/Database'
import type { SyncBackend } from '../../sync/SyncBackend'
import { ALL_MIGRATIONS, runMigrations } from '../../db/migrations'
import { FakeSyncBackend } from '../../sync/__tests__/fakes'
import { seedTag } from '../../sync/__tests__/helpers'
import { hashDatabase } from '../../sync/hashDatabase'
import { readSchemaVersion } from '../../sync/schemaVersion'
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
  await runMigrations(db, ALL_MIGRATIONS)
  return db
}

// A minimal backend stub — only the method the composable uses.
function fakeBackend(hash: string): SyncBackend {
  return {
    remoteId: 'stub',
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
      remoteId: 'failing',
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

describe('useSyncSettings — sync outcome, live backend, shared guard', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /** A remote written by a newer app version: runSync aborts without merging. */
  function newerSchemaBackend(): SyncBackend {
    return {
      remoteId: 'newer',
      getMetadata: async () => ({
        device: 'other-device',
        uploadedAtUtc: '2026-05-20T10:00:00.000Z',
        hash: 'sha256:remote',
        migrationVersion: 999,
      }),
      downloadDatabase: async () => {
        throw new Error('must not download a newer-schema remote')
      },
      hashDatabase: async () => 'sha256:local',
      tryUpload: async () => true,
    }
  }

  it('reports an aborted sync (remote from a newer app version) as an error, not success', async () => {
    saveSyncError({ atUtc: '2026-05-28T10:00:00.000Z', message: 'old' })
    const db = await migratedDb()
    const s = useSyncSettings({ db, backend: newerSchemaBackend() })
    await s.syncNow()
    expect(s.lastSyncError.value?.message).toMatch(/newer version/i)
    expect(loadSyncError()?.message).toMatch(/newer version/i)
    await db.close()
  })

  it('migrates a remote written by an older app version, then merges it', async () => {
    const db = await migratedDb()
    const backend = new FakeSyncBackend()
    // A database written by an older app: the migrations up to version 2.
    const old = new Database()
    await old.init()
    await runMigrations(old, ALL_MIGRATIONS.slice(0, 2))
    const at = '2026-05-21T00:00:00.000Z'
    await seedTag(old, { id: 'tag000000001', name: 'Home', created: at, updated: at })
    await backend.setRemote(old, {
      device: 'older app',
      uploadedAtUtc: at,
      hash: await hashDatabase(old),
      migrationVersion: 2,
    })
    // The schema version of the downloaded copy as downloaded, and when the
    // sync is done with it.
    let downloadedVersion: number | null = null
    let mergedVersion: number | null = null
    const download = backend.downloadDatabase.bind(backend)
    backend.downloadDatabase = async () => {
      const remote = await download()
      downloadedVersion = await readSchemaVersion(remote)
      const close = remote.close.bind(remote)
      remote.close = async () => {
        mergedVersion = await readSchemaVersion(remote)
        await close()
      }
      return remote
    }
    const s = useSyncSettings({ db, backend })

    await s.syncNow()

    expect(s.lastSyncError.value).toBeNull()
    expect(s.lastSyncOutcome.value).toMatchObject({ decision: 'merge', uploaded: true })
    expect(downloadedVersion).toBe(2)
    expect(mergedVersion).toBe(await readSchemaVersion(db))
    expect(backend.peekMeta()?.migrationVersion).toBe(await readSchemaVersion(db))
    expect(await db.exec('SELECT id FROM tags')).toEqual([{ id: 'tag000000001' }])
    await db.close()
    await backend.close()
  })

  it('exposes a summary of the last successful sync', async () => {
    const db = await migratedDb()
    const backend = new FakeSyncBackend()
    const s = useSyncSettings({ db, backend })
    await s.syncNow()
    expect(s.lastSyncOutcome.value).toMatchObject({ decision: 'first-sync-upload', conflicts: 0 })
    await db.close()
    await backend.close()
  })

  it('follows the backend currently registered, not the one present at setup', async () => {
    const db = await migratedDb()
    const backend = shallowRef<SyncBackend | null>(fakeBackend('sha256:a'))
    const s = useSyncSettings({ db, backend })
    expect(s.backendAvailable.value).toBe(true)

    backend.value = null // e.g. the user switched the provider to "None"
    expect(s.backendAvailable.value).toBe(false)
    await s.recomputeLocalHash()
    expect(s.localHash.value).toBeNull()
    await db.close()
  })

  it('reports provider-config saves so the backend can be rebuilt', () => {
    const saved: string[] = []
    const s = useSyncSettings({
      db: null,
      backend: null,
      onProviderConfigSaved: (cfg) => saved.push(cfg.active),
    })
    s.providerConfig.value.active = 'github'
    s.saveProviderConfig()
    expect(saved).toEqual(['github'])
  })

  it('hands the rebuilt backend a snapshot, so later unsaved edits cannot reach it', () => {
    let received: import('../../sync/localState').ProviderConfig | null = null
    const s = useSyncSettings({
      db: null,
      backend: null,
      onProviderConfigSaved: (cfg) => {
        received = cfg
      },
    })
    s.providerConfig.value.github.token = 'saved-token'
    s.saveProviderConfig()
    s.providerConfig.value.github.token = 'half-typ' // the user keeps typing, not saved yet
    expect(received!.github.token).toBe('saved-token')
  })

  it('shares the in-progress flag across instances, so a second page instance cannot start a parallel sync', async () => {
    const db = await migratedDb()
    let releaseMetadata!: () => void
    let syncsStarted = 0
    const slowBackend: SyncBackend = {
      remoteId: 'slow',
      getMetadata: () =>
        new Promise((resolve) => {
          syncsStarted++
          releaseMetadata = () => resolve(null)
        }),
      downloadDatabase: async () => {
        throw new Error('not used')
      },
      hashDatabase: async () => 'sha256:x',
      tryUpload: async () => true,
    }
    const first = useSyncSettings({ db, backend: slowBackend })
    const running = first.syncNow()
    // The user navigates away and back: a fresh composable instance.
    const second = useSyncSettings({ db, backend: slowBackend })
    expect(second.syncing.value).toBe(true)
    await second.syncNow() // must return without starting a sync

    await vi.waitFor(() => expect(releaseMetadata).toBeDefined())
    expect(syncsStarted).toBe(1)
    releaseMetadata()
    await running
    expect(second.syncing.value).toBe(false)
    await db.close()
  })
})
