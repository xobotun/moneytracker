import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import type { SyncMetadata } from '../types'
import { decideSync, runSync } from '../syncOrchestrator'
import { FakeSyncBackend } from './fakes'
import { readRows } from '../rows'
import { newMigratedDb, seedLocation } from './helpers'
import type { SyncBackend } from '../SyncBackend'
import { hashDatabase } from '../hashDatabase'

const META = (over: Partial<SyncMetadata> = {}): SyncMetadata => ({
  device: 'other-device',
  uploadedAtUtc: '2026-05-20T10:00:00.000Z',
  hash: 'remote-hash',
  migrationVersion: 2,
  ...over,
})

describe('decideSync', () => {
  it('returns "none" when the local hash equals the remote hash', () => {
    expect(decideSync('same', META({ hash: 'same' }), 'dev-A')).toBe('none')
  })

  it('returns "upload-local" when this device was the last uploader and the DBs differ', () => {
    expect(decideSync('local-hash', META({ device: 'dev-A', hash: 'remote-hash' }), 'dev-A')).toBe(
      'upload-local',
    )
  })

  it('returns "merge" when a different device last modified the remote', () => {
    expect(decideSync('local-hash', META({ device: 'dev-B', hash: 'remote-hash' }), 'dev-A')).toBe(
      'merge',
    )
  })
})

describe('runSync', () => {
  let local: Database
  let backend: FakeSyncBackend

  afterEach(async () => {
    if (local) await local.close()
    if (backend) await backend.close()
  })

  function deps(backend: FakeSyncBackend) {
    const state: { lastKnown: import('../types').RemoteState | null } = { lastKnown: null }
    return {
      backend,
      deviceName: 'dev-A',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
      migrate: async () => {},
      loadLastKnown: () => state.lastKnown,
      saveLastKnown: (s: import('../types').RemoteState) => {
        state.lastKnown = s
      },
      sleep: async () => {},
    }
  }

  it('uploads the local database on first sync when the remote is empty', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()

    const outcome = await runSync(local, deps(backend))

    expect(outcome.decision).toBe('first-sync-upload')
    expect(outcome.uploaded).toBe(true)
    expect(await backend.getMetadata()).not.toBeNull()
  })

  it('does nothing when local and remote already match', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    const d = deps(backend)
    const hash = await d.backend.hashDatabase(local)
    const seedDb = await newMigratedDb()
    await backend.setRemote(seedDb, META({ device: 'dev-B', hash }))

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('none')
    expect(outcome.uploaded).toBe(false)
  })

  it('merges a foreign upload and writes the result back', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    const d = deps(backend)
    // Remote, produced by another device, carries a location the local DB lacks.
    const remoteDb = await newMigratedDb()
    await seedLocation(remoteDb, {
      id: 'loc-remote',
      name: 'From device B',
      created: '2026-05-21T00:00:00.000Z',
      updated: '2026-05-21T00:00:00.000Z',
    })
    const remoteHash = await d.backend.hashDatabase(remoteDb)
    await backend.setRemote(remoteDb, META({ device: 'dev-B', hash: remoteHash }))

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('merge')
    expect(outcome.uploaded).toBe(true)
    expect(await readRows(local, 'locations')).toHaveLength(1)
  })

  it('re-merges when a concurrent upload makes the first CAS upload fail', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    const d = deps(backend)
    const remoteDb = await newMigratedDb()
    await seedLocation(remoteDb, {
      id: 'loc-1',
      name: 'Initial remote',
      created: '2026-05-21T00:00:00.000Z',
      updated: '2026-05-21T00:00:00.000Z',
    })
    const remoteHash = await d.backend.hashDatabase(remoteDb)
    await backend.setRemote(remoteDb, META({ device: 'dev-B', hash: remoteHash }))

    // Simulate device C uploading once, during our first upload attempt.
    const originalTryUpload = backend.tryUpload.bind(backend)
    let firstCall = true
    backend.tryUpload = async (localDb, metadata, expected) => {
      if (firstCall) {
        firstCall = false
        const otherDb = await newMigratedDb()
        await seedLocation(otherDb, {
          id: 'loc-2',
          name: 'Sneaked in',
          created: '2026-05-21T12:00:00.000Z',
          updated: '2026-05-21T12:00:00.000Z',
        })
        const otherHash = await d.backend.hashDatabase(otherDb)
        await backend.setRemote(otherDb, META({ device: 'dev-C', hash: otherHash }))
      }
      return originalTryUpload(localDb, metadata, expected)
    }

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('merge')
    expect(outcome.uploaded).toBe(true)
    // Both the original remote row and the sneaked-in row survived the re-merge.
    expect((await readRows(local, 'locations')).map((r) => r.id).sort()).toEqual(['loc-1', 'loc-2'])
  })

  it('aborts when the remote schema is newer than this app', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    const d = deps(backend)
    const remoteDb = await newMigratedDb()
    // Seed a row so the remote hash differs from the local hash. Two empty
    // DBs would hash equal and decideSync would short-circuit to 'none',
    // never reaching the schema gate.
    await seedLocation(remoteDb, {
      id: 'loc-future',
      name: 'From newer schema',
      created: '2026-05-21T00:00:00.000Z',
      updated: '2026-05-21T00:00:00.000Z',
    })
    const remoteHash = await d.backend.hashDatabase(remoteDb)
    await backend.setRemote(
      remoteDb,
      META({ device: 'dev-B', hash: remoteHash, migrationVersion: 99 }),
    )

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('aborted-app-outdated')
    expect(outcome.uploaded).toBe(false)
  })
})

describe('runSync retry bound', () => {
  let local: Database
  const opened: Database[] = []

  afterEach(async () => {
    if (local) await local.close()
    for (const db of opened.splice(0)) await db.close()
  })

  /** A remote that rejects every upload, as if another device always wins the race. */
  function alwaysLosingBackend(remoteDevice: string) {
    let uploads = 0
    const backend: SyncBackend = {
      getMetadata: async () => META({ device: remoteDevice, hash: `remote-${uploads}` }),
      downloadDatabase: async () => {
        const db = await newMigratedDb()
        opened.push(db)
        return db
      },
      hashDatabase,
      tryUpload: async () => {
        uploads++
        // Guard so a missing bound fails the test instead of spinning forever.
        if (uploads > 20) throw new Error('runaway retry loop')
        return false
      },
    }
    return { backend, uploads: () => uploads }
  }

  function boundedDeps(backend: SyncBackend, sleeps: number[]) {
    return {
      backend,
      deviceName: 'dev-A',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
      migrate: async () => {},
      loadLastKnown: () => null,
      saveLastKnown: () => {},
      maxAttempts: 3,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
    }
  }

  it('gives up after maxAttempts when a foreign upload keeps winning (merge path)', async () => {
    local = await newMigratedDb()
    const { backend, uploads } = alwaysLosingBackend('dev-B')
    const sleeps: number[] = []

    await expect(runSync(local, boundedDeps(backend, sleeps))).rejects.toThrow(
      /gave up after 3 attempts/,
    )
    expect(uploads()).toBe(3)
  })

  it('gives up after maxAttempts on the upload-local path too', async () => {
    local = await newMigratedDb()
    const { backend, uploads } = alwaysLosingBackend('dev-A')
    const sleeps: number[] = []

    await expect(runSync(local, boundedDeps(backend, sleeps))).rejects.toThrow(
      /gave up after 3 attempts/,
    )
    expect(uploads()).toBe(3)
  })

  it('does not report a lost first upload as success', async () => {
    local = await newMigratedDb()
    let uploads = 0
    const emptyRemoteLosingRace: SyncBackend = {
      getMetadata: async () => null, // remote looks empty every time
      downloadDatabase: async () => {
        throw new Error('not used')
      },
      hashDatabase,
      tryUpload: async () => {
        uploads++
        return false // another device's first upload got there first
      },
    }
    const saved: unknown[] = []
    const deps = {
      ...boundedDeps(emptyRemoteLosingRace, []),
      saveLastKnown: (s: unknown) => saved.push(s),
    }

    await expect(runSync(local, deps)).rejects.toThrow(/gave up after 3 attempts/)
    expect(uploads).toBe(3)
    expect(saved).toEqual([]) // no baseline recorded for an upload that never happened
  })

  it('backs off with growing delays between attempts', async () => {
    local = await newMigratedDb()
    const { backend } = alwaysLosingBackend('dev-B')
    const sleeps: number[] = []

    await expect(runSync(local, boundedDeps(backend, sleeps))).rejects.toThrow()
    expect(sleeps).toHaveLength(2) // between 3 attempts
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!)
  })
})
