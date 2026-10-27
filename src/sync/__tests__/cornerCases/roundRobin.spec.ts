import { describe, it, expect, afterEach } from 'vitest'
import type { ShortId } from '../../../db/shortId'
import type { UUID } from '../../../db/uuid'
import type { SyncBackend } from '../../SyncBackend'
import { at, minute, openTrio, openWorld, settle, start, type Device, type World } from '../devices'
import { balances, expectSound, openAccount, part, partsOf, record, tagRow } from './fixtures'

// Three devices that each change tags and transactions offline, then sync in
// different orders; and a device whose upload loses the race to another
// device's after it has merged (the orchestrator merges again, on top of its
// first, already applied merge).

let world: World

afterEach(async () => {
  await world.close()
})

describe('three devices', () => {
  it.each([
    ['A, B, C', [0, 1, 2]],
    ['C, B, A', [2, 1, 0]],
    ['B, C, A', [1, 2, 0]],
  ])('end alike whatever their order (%s)', async (_, order) => {
    const [a, b, c] = (world = await openTrio()).devices
    let food!: ShortId, groceries!: ShortId, fun!: ShortId, x!: ShortId, y!: ShortId
    let germany!: ShortId, berlin!: ShortId
    let wallet!: ShortId, card!: ShortId, cash!: ShortId, t1!: UUID, t2!: UUID
    await start(world, async (d) => {
      food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      groceries = (await d.tags.create({ kind: 'category', name: 'Groceries' })).id
      fun = (await d.tags.create({ kind: 'category', name: 'Fun' })).id
      x = (await d.tags.create({ kind: 'tag', name: 'job' })).id
      y = (await d.tags.create({ kind: 'tag', name: 'work' })).id
      germany = (await d.tags.create({ kind: 'location', name: 'Germany' })).id
      berlin = (await d.tags.create({ kind: 'location', name: 'Berlin', parent_id: germany })).id
      wallet = await openAccount(d, 'Wallet')
      card = await openAccount(d, 'Card')
      cash = await openAccount(d, 'Cash')
      t1 = await record(d, { from: wallet, to: null, parts: [part(groceries, 10000)], tags: [x] })
      t2 = await record(d, { from: wallet, to: card, parts: [part(fun, 5000)] })
    })
    at(minute(1))
    await a.tags.merge(groceries, food)
    await a.tags.move(berlin, null)
    at(minute(2))
    await b.tags.softDelete(germany)
    await b.tags.merge(x, y)
    await b.transactions.update(t1, { categories: [part(groceries, 5000), part(fun, 5000)] })
    at(minute(3))
    const t3 = await record(c, {
      from: wallet,
      to: null,
      parts: [part(groceries, 2000)],
      tags: [x],
      location: berlin,
    })
    await c.transactions.update(t2, { account_id__to: cash })
    let step = 4
    for (const i of order) {
      at(minute(step++))
      await world.devices[i]!.sync()
    }

    await settle([a, b, c], step)
    await expectSound([a, b, c])
    for (const d of [a, b, c]) {
      expect(await tagRow(d, groceries)).toMatchObject({ merged_into_id: food })
      expect(await tagRow(d, germany)).toMatchObject({ merged_into_id: null })
      expect(await tagRow(d, berlin)).toMatchObject({ parent_id: null, deleted_at_utc: null })
      expect(await partsOf(d, t1)).toEqual([
        [food, 5000, 2],
        [fun, 5000, 2],
      ])
      expect(await d.transactions.findById(t3)).toMatchObject({ tags: [y], location_id: berlin })
      expect(await partsOf(d, t3)).toEqual([[food, 2000, 2]])
      expect(await balances(d)).toEqual({
        [wallet]: [-17000, 2],
        [card]: [0, 2],
        [cash]: [5000, 2],
      })
    }
  })
})

describe('an upload that loses the race after a merge', () => {
  it('merges again over its first merge and converges', async () => {
    // A merges C's upload (undoing a loop) and, before its upload lands, B
    // uploads. A's second attempt merges B's upload into a database that
    // already holds the first merge and its repair.
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
    world = await openWorld(['A', 'B', 'C'], 'memory', racing)
    const [a, b, c] = world.devices as [Device, Device, Device]
    let p!: ShortId, q!: ShortId, r!: ShortId
    await start(world, async ({ tags }) => {
      p = (await tags.create({ kind: 'tag', name: 'p' })).id
      q = (await tags.create({ kind: 'tag', name: 'q' })).id
      r = (await tags.create({ kind: 'tag', name: 'r' })).id
    })
    at(minute(1))
    await a.tags.move(p, q)
    at(minute(2))
    await c.tags.move(q, p) // the later move: undone
    at(minute(3))
    await b.tags.merge(r, q)
    at(minute(4))
    await c.sync()
    at(minute(5))
    race = async () => {
      at(minute(5.5))
      expect((await b.sync()).decision).toBe('merge')
      at(minute(6))
    }
    uploadsTried = 0
    const onA = await a.sync()
    expect(race).toBeNull()
    expect(uploadsTried).toBe(2)
    expect(onA.decision).toBe('merge')

    await settle([a, b, c], 7)
    await expectSound([a, b, c])
    for (const d of [a, b, c]) {
      expect(await tagRow(d, p)).toMatchObject({ parent_id: q })
      expect(await tagRow(d, q)).toMatchObject({ parent_id: null })
      expect(await tagRow(d, r)).toMatchObject({ merged_into_id: q })
    }
  })
})
