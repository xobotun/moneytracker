import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ShortId } from '../../db/shortId'
import { seedAccount, seedTransaction } from './helpers'
import {
  at,
  expectConverged,
  minute,
  T0,
  openPair,
  start,
  type Device,
  type World,
} from './devices'

// Two devices sync through one remote with the real orchestrator (see
// devices.ts). After the devices have synced in turn, both databases must
// hold the same rows.

describe('two devices converge', () => {
  let world: World
  let a: Device
  let b: Device

  beforeEach(async () => {
    ;[a, b] = (world = await openPair()).devices
  })

  afterEach(async () => {
    await world.close()
  })

  const tagRow = async (device: Device, id: string) =>
    (await device.db.exec('SELECT * FROM tags WHERE id = ?', [id]))[0]!

  // Relies on today's timestamp cutoff (A's rename of d wins only because B's tombstone predates
  // A's cutoff; with real change detection delete-wins keeps d deleted). Revisit with TASKS.md
  // "Sync: tell which side changed a row without timestamps" — docs/plans/2026-10-26-sync-change-detection.md.
  it('after a lift whose deleted parent comes back', async () => {
    let g!: ShortId, d!: ShortId, c!: ShortId
    await start(world, async ({ tags }) => {
      g = (await tags.create({ kind: 'tag', name: 'g' })).id
      d = (await tags.create({ kind: 'tag', name: 'd', parent_id: g })).id
      c = (await tags.create({ kind: 'tag', name: 'c' })).id
    })
    at(minute(1))
    await a.tags.move(c, d)
    at(minute(2))
    await b.tags.softDelete(d)
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync() // c arrives under the deleted d: lifted to g, timestamp kept
    expect(await tagRow(b, c)).toMatchObject({ parent_id: g, updated_at_utc: minute(1) })
    at(minute(5))
    await a.tags.update(d, { name: 'd again' }) // brings d back on its next sync
    at(minute(6))
    await a.sync()
    at(minute(7))
    await b.sync()

    await expectConverged([a, b], minute(8))
    // Both copies of c tie on their timestamp: the devices picked the same one.
    expect([g, d]).toContain((await tagRow(a, c)).parent_id)
    expect(await tagRow(a, d)).toMatchObject({ deleted_at_utc: null })
  })

  // Relies on today's timestamp cutoff (a live row wins over an older remote merge). Revisit with
  // TASKS.md "Sync: tell which side changed a row without timestamps" — docs/plans/2026-10-26-sync-change-detection.md.
  it('after a redirect whose merged tag comes back', async () => {
    let x!: ShortId, y!: ShortId
    await start(world, async ({ db, tags }) => {
      x = (await tags.create({ kind: 'tag', name: 'job' })).id
      y = (await tags.create({ kind: 'tag', name: 'work' })).id
      await seedAccount(db, { id: 'acc', name: 'Wallet', created: T0, updated: T0 })
    })
    at(minute(1))
    await seedTransaction(a.db, {
      id: 'txn',
      accountFrom: 'acc',
      tags: [x],
      created: minute(1),
      updated: minute(1),
    })
    at(minute(2))
    await b.tags.merge(x, y)
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync() // the transaction arrives tagged with the merged x: redirected to y
    const txnOnB = (await b.db.exec('SELECT tags FROM transactions'))[0]!
    expect(txnOnB.tags).toBe(JSON.stringify([y]))
    at(minute(5))
    await a.tags.update(x, { name: 'job again' }) // its live row wins over the merge
    at(minute(6))
    await a.sync()
    at(minute(7))
    await b.sync()

    await expectConverged([a, b], minute(8))
  })

  it('after a parent loop is undone', async () => {
    let p!: ShortId, ta!: ShortId, tb!: ShortId
    await start(world, async ({ tags }) => {
      p = (await tags.create({ kind: 'category', name: 'p' })).id
      ta = (await tags.create({ kind: 'category', name: 'a' })).id
      tb = (await tags.create({ kind: 'category', name: 'b', parent_id: p })).id
    })
    at(minute(1))
    await a.tags.move(ta, tb)
    at(minute(2))
    await b.tags.move(tb, ta)
    at(minute(3))
    await a.sync()
    at(minute(4))
    const outcome = await b.sync()
    expect(outcome.conflicts.map((c) => [c.primaryKey, c.resolution])).toEqual([
      [tb, 'loop-undone'],
    ])
    at(minute(5))
    await a.sync()

    await expectConverged([a, b], minute(6))
    expect(await tagRow(a, ta)).toMatchObject({ parent_id: tb })
    expect(await tagRow(a, tb)).toMatchObject({ parent_id: p })
  })

  it('after a merge cycle is broken, keeping the earlier merge’s names', async () => {
    let x!: ShortId, y!: ShortId
    await start(world, async ({ tags }) => {
      x = (await tags.create({ kind: 'tag', name: 'job' })).id
      y = (await tags.create({ kind: 'tag', name: 'work' })).id
    })
    at(minute(1))
    await a.tags.merge(x, y) // y gets "job" as a synonym
    at(minute(2))
    await b.tags.merge(y, x) // the later merge: undone
    at(minute(3))
    expect((await b.sync()).decision).toBe('upload-local')
    at(minute(4))
    const onA = await a.sync()
    expect(onA.conflicts.filter((c) => c.resolution === 'loop-undone')).toEqual([
      expect.objectContaining({ primaryKey: y, winner: 'local' }),
    ])
    at(minute(5))
    // B's own deleted y wins its merge again ("delete wins"): B meets the
    // cycle too, and restores y exactly as A did.
    const onB = await b.sync()
    expect(onB.conflicts.filter((c) => c.resolution === 'loop-undone')).toEqual([
      expect.objectContaining({ primaryKey: y, winner: 'remote' }),
    ])

    await expectConverged([a, b], minute(6))
    const restored = {
      deleted_at_utc: null,
      merged_into_id: null,
      synonyms: '["job"]',
      updated_at_utc: '2026-05-01T01:02:00.001Z',
    }
    expect(await tagRow(a, y)).toMatchObject(restored)
    expect(await tagRow(b, y)).toMatchObject(restored)
    expect(await tagRow(a, x)).toMatchObject({ merged_into_id: y })
  })
})
