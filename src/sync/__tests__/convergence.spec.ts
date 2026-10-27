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

  it('after a lift, when the other device renames the deleted parent', async () => {
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
    await a.tags.update(d, { name: 'd again' })
    at(minute(6))
    // Both devices changed d since they last agreed: the delete wins over the rename.
    const onA = await a.sync()
    at(minute(7))
    await b.sync()

    await expectConverged([a, b], minute(8))
    expect(onA.conflicts.filter((conflict) => conflict.primaryKey === d)).toMatchObject([
      { winner: 'remote', resolution: 'delete-wins', local: { name: 'd again' } },
    ])
    expect(await tagRow(a, d)).toMatchObject({ deleted_at_utc: minute(2) })
    expect(await tagRow(a, c)).toMatchObject({ parent_id: g })
  })

  it('after a redirect, when the other device renames the merged tag', async () => {
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
    await a.tags.update(x, { name: 'job again' })
    at(minute(6))
    // Both devices changed x since they last agreed: the merge (a delete) wins over the rename.
    const onA = await a.sync()
    at(minute(7))
    await b.sync()

    await expectConverged([a, b], minute(8))
    expect(onA.conflicts.filter((conflict) => conflict.primaryKey === x)).toMatchObject([
      { winner: 'remote', resolution: 'delete-wins', local: { name: 'job again' } },
    ])
    for (const device of [a, b]) {
      expect(await tagRow(device, x)).toMatchObject({ merged_into_id: y, name: 'job' })
      const [txn] = await device.db.exec('SELECT tags FROM transactions')
      expect(txn!.tags).toBe(JSON.stringify([y]))
    }
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
    // B changed neither x nor y since its upload; both come back changed by
    // A's repair, so B takes them and never meets the cycle. The undone merge
    // is reported once, on A.
    const onB = await b.sync()
    expect(onB.decision).toBe('merge')
    expect(onB.conflicts).toEqual([])

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
