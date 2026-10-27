import { describe, it, expect, afterEach } from 'vitest'
import type { ShortId } from '../../../db/shortId'
import type { SyncBackend } from '../../SyncBackend'
import { hashDatabase } from '../../hashDatabase'
import { readSchemaVersion } from '../../schemaVersion'
import { readSyncBaseInfo } from '../../syncBase'
import {
  at,
  C,
  minute,
  openPair,
  openWorld,
  settle,
  start,
  type Device,
  type World,
} from '../devices'
import { FakeSyncBackend } from '../fakes'
import { tagRow } from './fixtures'

// The sync base is the state a device last agreed on with its remote, as one
// hash per row (src/sync/syncBase.ts). These scenarios pin when it stands in
// for that state: never for another remote, which has a history of its own;
// after a merge whose upload lost the race, as the remote that was merged; and
// not at all on the first sync after an update from a version without it.

describe('the sync base', () => {
  let world: World
  const remotes: FakeSyncBackend[] = []

  afterEach(async () => {
    await world.close()
    for (const remote of remotes.splice(0)) await remote.close()
  })

  it('is not used with another remote, whose copy of a row may be older', async () => {
    // A's backend can be switched, as when the user picks another provider;
    // what A knows of its last sync stays.
    let first!: SyncBackend
    let switched: SyncBackend | null = null
    const switchable = (backend: SyncBackend, device: string): SyncBackend => {
      if (device !== 'A') return backend
      first = backend
      const current = () => switched ?? backend
      return {
        get remoteId() {
          return current().remoteId
        },
        getMetadata: () => current().getMetadata(),
        downloadDatabase: () => current().downloadDatabase(),
        hashDatabase: (db) => current().hashDatabase(db),
        tryUpload: (db, meta, expected) => current().tryUpload(db, meta, expected),
      }
    }
    world = await openWorld(['A', 'B'], 'memory', switchable)
    const [a] = world.devices as [Device, Device]
    let x!: ShortId
    await start(world, async ({ tags }) => {
      x = (await tags.create({ kind: 'tag', name: 'home' })).id
    })
    // Another remote holds the data as it stood at C.
    const stale = await first.downloadDatabase()
    const other = new FakeSyncBackend('other')
    remotes.push(other)
    await other.setRemote(stale, {
      device: 'B',
      uploadedAtUtc: C,
      hash: await hashDatabase(stale),
      migrationVersion: await readSchemaVersion(a.db),
    })
    at(minute(1))
    await a.tags.update(x, { name: 'house' })
    at(minute(2))
    expect((await a.sync()).decision).toBe('merge') // A's base now holds 'house'

    switched = other
    at(minute(3))
    expect((await a.sync()).decision).toBe('merge')

    // Against A's base the old row would look changed and win; the cutoff of
    // A's last sync sees two unchanged rows, and the later one wins.
    expect(await tagRow(a, x)).toMatchObject({ name: 'house' })
    expect((await readSyncBaseInfo(a.db))?.remoteId).toBe('other')
  })

  it('keeps a restore made while a merged upload loses the race', async () => {
    // A merges B's delete of t; before A's upload lands, B restores t and
    // uploads. A's retry compares with the remote it merged, where t was
    // already deleted: only B changed t since, so the restore is kept.
    let race: (() => Promise<void>) | null = null
    let uploadsTried = 0
    const racing = (backend: SyncBackend, device: string): SyncBackend =>
      device !== 'A'
        ? backend
        : {
            remoteId: backend.remoteId,
            getMetadata: () => backend.getMetadata(),
            downloadDatabase: () => backend.downloadDatabase(),
            hashDatabase: (db) => backend.hashDatabase(db),
            tryUpload: async (db, meta, expected) => {
              uploadsTried++
              const other = race
              race = null
              if (other) await other()
              return backend.tryUpload(db, meta, expected)
            },
          }
    world = await openWorld(['A', 'B'], 'memory', racing)
    const [a, b] = world.devices as [Device, Device]
    let t!: ShortId
    await start(world, async ({ tags }) => {
      t = (await tags.create({ kind: 'tag', name: 'trip' })).id
    })
    at(minute(1))
    await b.tags.softDelete(t)
    at(minute(2))
    expect((await b.sync()).decision).toBe('upload-local')
    at(minute(3))
    race = async () => {
      at(minute(3.5))
      await b.tags.restore(t)
      at(minute(4))
      expect((await b.sync()).decision).toBe('upload-local')
      at(minute(5))
    }
    uploadsTried = 0
    const onA = await a.sync()
    expect(race).toBeNull()
    expect(uploadsTried).toBe(2)
    expect(onA.decision).toBe('merge')
    expect(await tagRow(a, t)).toMatchObject({ deleted_at_utc: null })

    await settle([a, b], 6)
    for (const d of [a, b]) expect(await tagRow(d, t)).toMatchObject({ deleted_at_utc: null })
  })

  it('falls back to the cutoff on a device without a base, and writes one', async () => {
    const [a, b] = (world = await openPair()).devices
    let x!: ShortId, y!: ShortId
    await start(world, async ({ tags }) => {
      x = (await tags.create({ kind: 'tag', name: 'x' })).id
      y = (await tags.create({ kind: 'tag', name: 'y' })).id
    })
    // As after an update from a version without the sync base.
    await a.db.run('DELETE FROM sync_base')
    await a.db.run('DELETE FROM sync_base_info')
    at(minute(1))
    await b.tags.update(y, { name: 'y by B' })
    at(minute(2))
    await b.sync()
    at(minute(3))
    await a.tags.update(x, { name: 'x by A' })
    at(minute(4))
    expect((await a.sync()).decision).toBe('merge')

    expect(await tagRow(a, x)).toMatchObject({ name: 'x by A' })
    expect(await tagRow(a, y)).toMatchObject({ name: 'y by B' })
    expect(await readSyncBaseInfo(a.db)).toMatchObject({
      remoteId: 'memory',
      databaseHash: await hashDatabase(a.db),
    })
    await settle([a, b], 5)
  })
})
