import { describe, it, expect, afterEach } from 'vitest'
import type { SyncMetadata } from '../types'
import { FakeSyncProvider, FakeDatabaseCodec } from './fakes'
import { readRows } from '../rows'
import { newMigratedDb, seedLocation } from './helpers'
import type { Database } from '../../db/Database'

const META = (over: Partial<SyncMetadata> = {}): SyncMetadata => ({
  device: 'dev-1',
  uploadedAtUtc: '2026-05-22T10:00:00.000Z',
  hash: 'h1',
  migrationVersion: 2,
  ...over,
})

describe('FakeSyncProvider', () => {
  it('starts empty', async () => {
    const p = new FakeSyncProvider()
    expect(await p.getMetadata()).toBeNull()
    await expect(p.download()).rejects.toThrow()
  })

  it('accepts a CAS upload when the expected metadata matches', async () => {
    const p = new FakeSyncProvider()
    expect(await p.upload(new Blob(['x']), META(), null)).toBe(true)
    expect(await p.getMetadata()).toEqual(META())
  })

  it('rejects a CAS upload when the remote moved underneath', async () => {
    const p = new FakeSyncProvider()
    await p.upload(new Blob(['x']), META(), null)
    const stale: SyncMetadata | null = null // caller thinks remote is still empty
    expect(await p.upload(new Blob(['y']), META({ hash: 'h2' }), stale)).toBe(false)
  })
})

describe('FakeDatabaseCodec', () => {
  let db: Database
  let reopened: Database

  afterEach(async () => {
    if (db) await db.close()
    if (reopened) await reopened.close()
  })

  it('round-trips a database through export and openFromBlob', async () => {
    const codec = new FakeDatabaseCodec()
    db = await newMigratedDb()
    await seedLocation(db, {
      id: 'loc-1',
      name: 'Round trip',
      created: '2026-05-01T00:00:00.000Z',
      updated: '2026-05-01T00:00:00.000Z',
    })

    const blob = await codec.export(db)
    reopened = await codec.openFromBlob(blob)

    const rows = await readRows(reopened, 'locations')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Round trip')
  })

  it('hashes equal blobs equally and different blobs differently', async () => {
    const codec = new FakeDatabaseCodec()
    expect(await codec.hash(new Blob(['same']))).toBe(await codec.hash(new Blob(['same'])))
    expect(await codec.hash(new Blob(['a']))).not.toBe(await codec.hash(new Blob(['b'])))
  })
})
