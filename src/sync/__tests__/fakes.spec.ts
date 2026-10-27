import { describe, it, expect, afterEach } from 'vitest'
import { FakeSyncBackend } from './fakes'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import type { SyncMetadata } from '../types'

const META = (over: Partial<SyncMetadata> = {}): SyncMetadata => ({
  device: 'dev-A',
  uploadedAtUtc: '2026-05-22T10:00:00.000Z',
  hash: 'sha256:h1',
  migrationVersion: 2,
  ...over,
})

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

describe('FakeSyncBackend', () => {
  let backend: FakeSyncBackend
  let cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    await backend?.close()
    for (const c of cleanups) await c()
    cleanups = []
  })

  it('starts empty', async () => {
    backend = new FakeSyncBackend()
    expect(await backend.getMetadata()).toBeNull()
  })

  it('names its remote "memory" unless given an id', () => {
    expect(new FakeSyncBackend().remoteId).toBe('memory')
    backend = new FakeSyncBackend('other')
    expect(backend.remoteId).toBe('other')
  })

  it('accepts a first-sync upload (expected === null)', async () => {
    backend = new FakeSyncBackend()
    const local = await migratedDb()
    cleanups.push(() => local.close())

    await backend.getMetadata()
    const ok = await backend.tryUpload(local, META(), null)
    expect(ok).toBe(true)
    expect(await backend.getMetadata()).toEqual(META())
  })

  it('rejects a CAS miss (expected does not match current remote)', async () => {
    backend = new FakeSyncBackend()
    const local = await migratedDb()
    cleanups.push(() => local.close())
    // Pre-seed the remote with a different metadata.
    const seedDb = await migratedDb()
    await backend.setRemote(seedDb, META({ hash: 'sha256:other' }))

    await backend.getMetadata()
    const ok = await backend.tryUpload(local, META(), null) // expected null, but remote isn't
    expect(ok).toBe(false)
  })

  it('downloadDatabase returns a fresh clone that the caller can mutate safely', async () => {
    backend = new FakeSyncBackend()
    const seed = await migratedDb()
    await seed.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'X', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
      ['loc-1'],
    )
    await backend.setRemote(seed, META())

    const downloaded = await backend.downloadDatabase()
    cleanups.push(() => downloaded.close())
    // Mutate the clone — must not affect the simulated remote.
    await downloaded.run('DELETE FROM tags WHERE id = ?', ['loc-1'])

    const downloadedAgain = await backend.downloadDatabase()
    cleanups.push(() => downloadedAgain.close())
    const rows = await downloadedAgain.exec('SELECT * FROM tags')
    expect(rows).toHaveLength(1)
  })

  it('throws when tryUpload is called without a prior getMetadata and remote is not empty', async () => {
    backend = new FakeSyncBackend()
    const seed = await migratedDb()
    await backend.setRemote(seed, META())
    const local = await migratedDb()
    cleanups.push(() => local.close())

    await expect(backend.tryUpload(local, META(), META())).rejects.toThrow(/prior getMetadata/)
  })
})

import { FakeBlobTransport } from './fakes'

describe('FakeBlobTransport', () => {
  it('returns null sidecar when empty', async () => {
    expect(await new FakeBlobTransport().getSidecar()).toBeNull()
  })

  it('putSidecar(text, null) succeeds when empty, fails when not empty', async () => {
    const t = new FakeBlobTransport()
    expect(await t.putSidecar('a', null)).toBe(true)
    expect(await t.putSidecar('b', null)).toBe(false)
  })

  it('putSidecar(text, etag) succeeds when etag matches and fails otherwise', async () => {
    const t = new FakeBlobTransport()
    await t.putSidecar('a', null)
    const first = (await t.getSidecar())!
    expect(await t.putSidecar('b', first.etag)).toBe(true)
    expect(await t.putSidecar('c', first.etag)).toBe(false) // stale etag
  })

  it('getBlob throws when no blob has been put', async () => {
    await expect(new FakeBlobTransport().getBlob()).rejects.toThrow(/no blob/)
  })

  it('putBlob then getBlob round-trips bytes', async () => {
    const t = new FakeBlobTransport()
    await t.putBlob(new Uint8Array([1, 2, 3]))
    expect(Array.from(await t.getBlob())).toEqual([1, 2, 3])
  })
})
