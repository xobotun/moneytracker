import { describe, it, expect, afterEach } from 'vitest'
import type { ShortId } from '../../../db/shortId'
import { at, minute, openPair, openTrio, settle, start, type Device, type World } from '../devices'
import { expectSound, tagRow } from './fixtures'

// Tag parents (decisions §2.1, §2.5) changed on different devices: children
// of tags deleted or merged elsewhere are lifted to the nearest live
// ancestor, and a parent loop that sync creates is undone at its later move.
// Duplicate names are kept and listed, never merged automatically.

describe('tag hierarchy on several devices', () => {
  let world: World

  afterEach(async () => {
    await world.close()
  })

  const parentOf = async (d: Device, id: ShortId) => (await tagRow(d, id)).parent_id

  it('lifts a new child of a tag deleted elsewhere past a parent merged elsewhere', async () => {
    const [a, b] = (world = await openPair()).devices
    let germany!: ShortId, deutschland!: ShortId, berlin!: ShortId
    await start(world, async ({ tags }) => {
      germany = (await tags.create({ kind: 'location', name: 'Germany' })).id
      deutschland = (await tags.create({ kind: 'location', name: 'Deutschland' })).id
      berlin = (await tags.create({ kind: 'location', name: 'Berlin', parent_id: germany })).id
    })
    at(minute(1))
    const alex = (await a.tags.create({ kind: 'location', name: 'Alex', parent_id: berlin })).id
    at(minute(2))
    await b.tags.softDelete(berlin)
    at(minute(3))
    await a.tags.merge(germany, deutschland) // moves Berlin under Deutschland on A
    at(minute(4))
    await a.sync()
    at(minute(5))
    await b.sync()

    await settle([a, b], 6)
    await expectSound([a, b])
    for (const d of [a, b]) expect(await parentOf(d, alex)).toBe(deutschland)
  })

  it('undoes the latest move of a three-tag loop made on three devices', async () => {
    const [a, b, c] = (world = await openTrio()).devices
    let x!: ShortId, y!: ShortId, z!: ShortId
    await start(world, async ({ tags }) => {
      x = (await tags.create({ kind: 'category', name: 'x' })).id
      y = (await tags.create({ kind: 'category', name: 'y' })).id
      z = (await tags.create({ kind: 'category', name: 'z' })).id
    })
    at(minute(1))
    await a.tags.move(x, y)
    at(minute(2))
    await b.tags.move(y, z)
    at(minute(3))
    await c.tags.move(z, x) // the latest move: undone
    at(minute(4))
    await a.sync()
    at(minute(5))
    await b.sync()
    at(minute(6))
    const onC = await c.sync()
    expect(onC.conflicts.map((k) => [k.primaryKey, k.resolution])).toEqual([[z, 'loop-undone']])

    await settle([a, b, c], 7)
    await expectSound([a, b, c])
    for (const d of [a, b, c]) {
      expect([await parentOf(d, x), await parentOf(d, y), await parentOf(d, z)]).toEqual([
        y,
        z,
        null,
      ])
    }
  })

  it('undoes a parent loop that only the repair’s redirect closes', async () => {
    // A moves Food under Shopping; B merges Shopping into Groceries, which is
    // under Food. Redirecting Shopping's child Food to Groceries closes the
    // loop Food > Groceries > Food.
    const [a, b] = (world = await openPair()).devices
    let food!: ShortId, groceries!: ShortId, shopping!: ShortId
    await start(world, async ({ tags }) => {
      food = (await tags.create({ kind: 'category', name: 'Food' })).id
      groceries = (await tags.create({ kind: 'category', name: 'Groceries', parent_id: food })).id
      shopping = (await tags.create({ kind: 'category', name: 'Shopping' })).id
    })
    at(minute(1))
    await b.tags.merge(shopping, groceries)
    at(minute(2))
    await a.tags.move(food, shopping) // the later move: undone
    at(minute(3))
    await a.sync()
    at(minute(4))
    const onB = await b.sync()
    expect(onB.conflicts.filter((c) => c.resolution === 'loop-undone')).toEqual([
      expect.objectContaining({ primaryKey: food }),
    ])

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect([await parentOf(d, food), await parentOf(d, groceries)]).toEqual([null, food])
    }
  })

  // A moves X under Y (minute 1), B moves Y under X (minute 2, the later
  // move), and A then renames X (minute 3). The rename makes X's row the
  // newer one, but the loop is undone at the tag moved last (moved_at_utc,
  // which only a move sets), so B's move is undone (§2.5: "the later move is
  // undone"). A merge that adds a synonym to a tag of the loop is the same.
  it('undoes the later move of a loop even when the other tag was renamed after its move', async () => {
    const [a, b] = (world = await openPair()).devices
    let p!: ShortId, x!: ShortId, y!: ShortId
    await start(world, async ({ tags }) => {
      p = (await tags.create({ kind: 'tag', name: 'p' })).id
      x = (await tags.create({ kind: 'tag', name: 'x' })).id
      y = (await tags.create({ kind: 'tag', name: 'y', parent_id: p })).id
    })
    at(minute(1))
    await a.tags.move(x, y)
    at(minute(2))
    await b.tags.move(y, x) // the later move
    at(minute(3))
    await a.tags.update(x, { name: 'x renamed' })
    at(minute(4))
    await a.sync()
    at(minute(5))
    await b.sync()

    await settle([a, b], 6)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect([await parentOf(d, x), await parentOf(d, y)]).toEqual([y, p])
    }
  })

  it('lists duplicates made on two devices until one is renamed or merged', async () => {
    const [a, b] = (world = await openPair()).devices
    await start(world, async ({ tags }) => {
      await tags.create({ kind: 'merchant', name: 'Lidl' })
    })
    at(minute(1))
    const r1 = (await a.tags.create({ kind: 'merchant', name: 'Rewe' })).id
    at(minute(2))
    const r2 = (await b.tags.create({ kind: 'merchant', name: 'Rewe' })).id
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync()
    const pair = [r1, r2].sort()
    let next = await settle([a, b], 5)
    for (const d of [a, b]) expect(await d.tags.duplicates()).toEqual([pair])

    // One is renamed: no duplicates left.
    at(minute(next))
    await a.tags.update(r1, { name: 'Rewe Mitte' })
    next = await settle([a, b], next + 1)
    for (const d of [a, b]) expect(await d.tags.duplicates()).toEqual([])

    // Both rename their copy alike (the name check sees only local tags).
    at(minute(next))
    await a.tags.update(r1, { name: 'Rewe City' })
    at(minute(next + 1))
    await b.tags.update(r2, { name: 'rewe city' })
    next = await settle([a, b], next + 2)
    for (const d of [a, b]) expect(await d.tags.duplicates()).toEqual([pair])

    at(minute(next))
    await b.tags.merge(r2, r1)
    await settle([a, b], next + 1)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await d.tags.duplicates()).toEqual([])
      expect((await d.tags.findByName('merchant', 'REWE CITY'))?.id).toBe(r1)
    }
  })
})
