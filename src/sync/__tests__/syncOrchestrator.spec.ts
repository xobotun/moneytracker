import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import type { RemoteState, SyncMetadata } from '../types'
import { changeDetectorFor, decideSync, runSync } from '../syncOrchestrator'
import { FakeSyncBackend } from './fakes'
import { readRows } from '../rows'
import { newMigratedDb, nonEmpty, seedAccount, seedTag, seedTransaction } from './helpers'
import type { SyncBackend } from '../SyncBackend'
import { hashDatabase } from '../hashDatabase'
import { readSchemaVersion } from '../schemaVersion'
import {
  readSyncBase,
  readSyncBaseInfo,
  snapshotDatabase,
  writeSyncBase,
  type BaseSource,
  type Snapshot,
} from '../syncBase'

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
    await seedTag(remoteDb, {
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
    expect(await readRows(local, 'tags')).toHaveLength(1)
  })

  it('uploads a merged database whose cached balances match its transactions', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    const d = deps(backend)
    const at = '2026-05-21T00:00:00.000Z'
    await seedAccount(local, { id: 'acc', name: 'Cash', created: at, updated: at })
    // Device B spent 1.00 USD from it; neither side's cache shows that yet.
    const remoteDb = await newMigratedDb()
    await seedAccount(remoteDb, { id: 'acc', name: 'Cash', created: at, updated: at })
    await seedTransaction(remoteDb, { id: 'txn', accountFrom: 'acc', created: at, updated: at })
    const remoteHash = await d.backend.hashDatabase(remoteDb)
    await backend.setRemote(remoteDb, META({ device: 'dev-B', hash: remoteHash }))

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('merge')
    // Rebuilt during the merge, so before the hash and the upload.
    const uploaded = await backend.downloadDatabase()
    try {
      expect((await readRows(uploaded, 'accounts'))[0]).toMatchObject({ balance_value: -100 })
    } finally {
      await uploaded.close()
    }
  })

  it('re-merges when a concurrent upload makes the first CAS upload fail', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    const d = deps(backend)
    const remoteDb = await newMigratedDb()
    await seedTag(remoteDb, {
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
        await seedTag(otherDb, {
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
    expect((await readRows(local, 'tags')).map((r) => r.id).sort()).toEqual(['loc-1', 'loc-2'])
  })

  it('aborts when the remote schema is newer than this app', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    const d = deps(backend)
    const remoteDb = await newMigratedDb()
    // Seed a row so the remote hash differs from the local hash. Two empty
    // DBs would hash equal and decideSync would short-circuit to 'none',
    // never reaching the schema gate.
    await seedTag(remoteDb, {
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

describe('runSync keeps the sync base', () => {
  let local: Database
  let backend: FakeSyncBackend

  afterEach(async () => {
    if (local) await local.close()
    if (backend) await backend.close()
  })

  function deps() {
    let lastKnown: RemoteState | null = null
    return {
      backend,
      deviceName: 'dev-A',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
      migrate: async () => {},
      loadLastKnown: () => lastKnown,
      saveLastKnown: (state: RemoteState) => {
        lastKnown = state
      },
      sleep: async () => {},
    }
  }

  const at = '2026-05-21T00:00:00.000Z'
  const seedHome = (db: Database) =>
    seedTag(db, { id: 'home', name: 'Home', created: at, updated: at })
  const seedWork = (db: Database) =>
    seedTag(db, { id: 'work', name: 'Work', created: at, updated: at })

  /** A remote holding `seed`'s rows, uploaded by `device`. */
  async function remoteOf(seed: (db: Database) => Promise<void>, device: string): Promise<string> {
    const db = await newMigratedDb()
    await seed(db)
    const hash = await hashDatabase(db)
    await backend.setRemote(db, META({ device, hash, migrationVersion: 3 }))
    return hash
  }

  /** The base holds the local rows, agreed with this remote at `databaseHash`. */
  async function expectBase(databaseHash: string): Promise<void> {
    expect(await readSyncBaseInfo(local)).toEqual({
      remoteId: 'memory',
      schemaVersion: await readSchemaVersion(local),
      databaseHash,
    })
    expect(await readSyncBase(local)).toEqual(nonEmpty((await snapshotDatabase(local)).rows))
  }

  it('writes the uploaded rows after a first upload', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    await seedHome(local)

    expect((await runSync(local, deps())).decision).toBe('first-sync-upload')

    await expectBase(backend.peekMeta()!.hash)
  })

  it('writes the uploaded rows after an upload of the local database', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    await seedHome(local)
    await remoteOf(async () => {}, 'dev-A')

    expect((await runSync(local, deps())).decision).toBe('upload-local')

    await expectBase(backend.peekMeta()!.hash)
  })

  it('writes the uploaded rows after a merge, stamped with their hash', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    await seedHome(local)
    await remoteOf(seedWork, 'dev-B')

    expect((await runSync(local, deps())).decision).toBe('merge')

    expect(backend.peekMeta()!.hash).toBe(await hashDatabase(local))
    await expectBase(backend.peekMeta()!.hash)
  })

  it('writes the rows read before the upload, stamped with their hash, though the app writes during it', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    await seedHome(local)
    const before = await snapshotDatabase(local)
    const tryUpload = backend.tryUpload.bind(backend)
    backend.tryUpload = async (db, meta, expected) => {
      await seedWork(local)
      return tryUpload(db, meta, expected)
    }

    expect((await runSync(local, deps())).decision).toBe('first-sync-upload')

    expect(backend.peekMeta()!.hash).toBe(before.databaseHash)
    expect(await readSyncBaseInfo(local)).toMatchObject({ databaseHash: before.databaseHash })
    expect(await readSyncBase(local)).toEqual(nonEmpty(before.rows))
  })

  const noBaseForThisRemote: [string, BaseSource | null][] = [
    ['without a base', null],
    ['with a base from another remote', { remoteId: 'github:me/mt@main', schemaVersion: 3 }],
  ]

  it.each(noBaseForThisRemote)(
    'adopts the remote as the base when nothing needs syncing, %s',
    async (_, source) => {
      local = await newMigratedDb()
      backend = new FakeSyncBackend()
      await seedHome(local)
      if (source) {
        const snapshot = await snapshotDatabase(local)
        await local.transaction((tx) => writeSyncBase(tx, snapshot, source))
      }
      const remoteHash = await remoteOf(seedHome, 'dev-B')

      expect((await runSync(local, deps())).decision).toBe('none')

      await expectBase(remoteHash)
    },
  )

  it('leaves a base already agreed with this remote alone when nothing needs syncing', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    await seedHome(local)
    const remoteHash = await remoteOf(seedHome, 'dev-B')
    // A marker row no snapshot of these rows would hold.
    const marked: Snapshot = {
      databaseHash: remoteHash,
      rows: new Map([['tags', new Map([['marker', 'not-a-row']])]]),
    }
    await local.transaction((tx) =>
      writeSyncBase(tx, marked, { remoteId: 'memory', schemaVersion: 3 }),
    )

    expect((await runSync(local, deps())).decision).toBe('none')

    expect(await readSyncBase(local)).toEqual(marked.rows)
  })

  it('writes no base when nothing needs syncing but the rows changed after they were hashed', async () => {
    local = await newMigratedDb()
    backend = new FakeSyncBackend()
    await seedHome(local)
    await remoteOf(seedHome, 'dev-B')
    // The app writes while the remote's metadata is on its way.
    const getMetadata = backend.getMetadata.bind(backend)
    backend.getMetadata = async () => {
      await seedWork(local)
      return getMetadata()
    }

    expect((await runSync(local, deps())).decision).toBe('none')

    expect(await readSyncBaseInfo(local)).toBeNull()
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
      remoteId: 'losing',
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
      remoteId: 'losing',
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

describe('changeDetectorFor', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  const TAGS = { name: 'tags', pk: 'id' }
  const SOURCE: BaseSource = { remoteId: 'memory', schemaVersion: 3 }
  const LAST_KNOWN: RemoteState = {
    device: 'dev-B',
    uploadedAtUtc: '2026-05-20T10:00:00.000Z',
    hash: 'remote-hash',
  }

  /** One tag stamped before the last sync, and a base of it agreed with `source`. */
  async function tagWithBase(source: BaseSource | null) {
    db = await newMigratedDb()
    const at = '2026-05-01T00:00:00.000Z'
    await seedTag(db, { id: 'home', name: 'Home', created: at, updated: at })
    if (source) {
      const snapshot = await snapshotDatabase(db)
      await db.transaction((tx) => writeSyncBase(tx, snapshot, source))
    }
    return (await readRows(db, 'tags'))[0]!
  }

  it('compares with the base agreed with this remote at this schema version', async () => {
    const row = await tagWithBase(SOURCE)

    const changes = await changeDetectorFor(db, SOURCE, LAST_KNOWN)

    expect(changes.exact).toBe(true)
    expect(await changes.changed(TAGS, row)).toBe(false)
    expect(await changes.changed(TAGS, { ...row, name: 'House' })).toBe(true)
  })

  const noUsableBase: [string, BaseSource | null][] = [
    ['without a base', null],
    ['with a base from another remote', { ...SOURCE, remoteId: 'github:me/mt@main' }],
    ['with a base from another schema version', { ...SOURCE, schemaVersion: 2 }],
  ]

  it.each(noUsableBase)('falls back to the cutoff of the last sync %s', async (_, source) => {
    const row = await tagWithBase(source)

    const changes = await changeDetectorFor(db, SOURCE, LAST_KNOWN)

    expect(changes.exact).toBe(false)
    // Stamped before the last sync: unchanged, whatever it holds.
    expect(await changes.changed(TAGS, { ...row, name: 'House' })).toBe(false)
    const later = '2026-05-21T00:00:00.000Z'
    expect(await changes.changed(TAGS, { ...row, updated_at_utc: later })).toBe(true)
  })

  it('takes every row for changed before the first sync', async () => {
    const row = await tagWithBase(null)

    const changes = await changeDetectorFor(db, SOURCE, null)

    expect(changes.exact).toBe(false)
    expect(await changes.changed(TAGS, row)).toBe(true)
  })
})
