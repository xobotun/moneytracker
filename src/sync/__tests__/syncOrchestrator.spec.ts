import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import type { SyncMetadata } from '../types'
import { decideSync, runSync } from '../syncOrchestrator'
import { FakeSyncProvider, FakeDatabaseCodec } from './fakes'
import { readRows } from '../rows'
import { newMigratedDb, seedLocation } from './helpers'

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

  afterEach(async () => {
    if (local) await local.close()
  })

  function deps(provider: FakeSyncProvider) {
    const state: { lastKnown: import('../types').RemoteState | null } = { lastKnown: null }
    return {
      provider,
      codec: new FakeDatabaseCodec(),
      deviceId: 'dev-A',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
      migrate: async () => {},
      loadLastKnown: () => state.lastKnown,
      saveLastKnown: (s: import('../types').RemoteState) => {
        state.lastKnown = s
      },
    }
  }

  it('uploads the local database on first sync when the remote is empty', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()

    const outcome = await runSync(local, deps(provider))

    expect(outcome.decision).toBe('first-sync-upload')
    expect(outcome.uploaded).toBe(true)
    expect(await provider.getMetadata()).not.toBeNull()
  })

  it('does nothing when local and remote already match', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()
    const d = deps(provider)
    const blob = await d.codec.export(local)
    const hash = await d.codec.hash(blob)
    provider.forceState(blob, META({ device: 'dev-B', hash }))

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('none')
    expect(outcome.uploaded).toBe(false)
  })

  it('merges a foreign upload and writes the result back', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()
    const d = deps(provider)
    // Remote, produced by another device, carries a location the local DB lacks.
    const remoteDb = await newMigratedDb()
    await seedLocation(remoteDb, {
      id: 'loc-remote',
      name: 'From device B',
      created: '2026-05-21T00:00:00.000Z',
      updated: '2026-05-21T00:00:00.000Z',
    })
    const remoteBlob = await d.codec.export(remoteDb)
    await remoteDb.close()
    provider.forceState(remoteBlob, META({ device: 'dev-B', hash: await d.codec.hash(remoteBlob) }))

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('merge')
    expect(outcome.uploaded).toBe(true)
    expect(await readRows(local, 'locations')).toHaveLength(1)
  })

  it('re-merges when a concurrent upload makes the first CAS upload fail', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()
    const d = deps(provider)
    const remoteDb = await newMigratedDb()
    await seedLocation(remoteDb, {
      id: 'loc-1',
      name: 'Initial remote',
      created: '2026-05-21T00:00:00.000Z',
      updated: '2026-05-21T00:00:00.000Z',
    })
    const remoteBlob = await d.codec.export(remoteDb)
    await remoteDb.close()
    provider.forceState(remoteBlob, META({ device: 'dev-B', hash: await d.codec.hash(remoteBlob) }))

    // Simulate device C uploading once, during our first upload attempt.
    provider.beforeUpload = async () => {
      const otherDb = await newMigratedDb()
      await seedLocation(otherDb, {
        id: 'loc-2',
        name: 'Sneaked in',
        created: '2026-05-21T12:00:00.000Z',
        updated: '2026-05-21T12:00:00.000Z',
      })
      const blob = await d.codec.export(otherDb)
      await otherDb.close()
      provider.forceState(blob, META({ device: 'dev-C', hash: await d.codec.hash(blob) }))
    }

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('merge')
    expect(outcome.uploaded).toBe(true)
    // Both the original remote row and the sneaked-in row survived the re-merge.
    expect((await readRows(local, 'locations')).map((r) => r.id).sort()).toEqual(['loc-1', 'loc-2'])
  })

  it('aborts when the remote schema is newer than this app', async () => {
    local = await newMigratedDb()
    const provider = new FakeSyncProvider()
    const d = deps(provider)
    const remoteDb = await newMigratedDb()
    // Seed a row so the remote hash differs from the local hash. The fake codec
    // only serializes domain rows (not the `migrations` table), so two empty
    // DBs at different schema versions would hash equal and decideSync would
    // short-circuit to 'none', never reaching the schema gate. The real codec
    // (full .sqlite blob) doesn't have this aliasing.
    await seedLocation(remoteDb, {
      id: 'loc-future',
      name: 'From newer schema',
      created: '2026-05-21T00:00:00.000Z',
      updated: '2026-05-21T00:00:00.000Z',
    })
    const remoteBlob = await d.codec.export(remoteDb)
    await remoteDb.close()
    provider.forceState(
      remoteBlob,
      META({ device: 'dev-B', hash: await d.codec.hash(remoteBlob), migrationVersion: 99 }),
    )

    const outcome = await runSync(local, d)

    expect(outcome.decision).toBe('aborted-app-outdated')
    expect(outcome.uploaded).toBe(false)
  })
})
