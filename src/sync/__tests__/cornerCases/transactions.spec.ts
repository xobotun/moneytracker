import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ShortId } from '../../../db/shortId'
import type { UUID } from '../../../db/uuid'
import { at, minute, openPair, settle, start, type Device, type World } from '../devices'
import { balances, expectSound, openAccount, part, partsOf, record, usd } from './fixtures'

// Transactions edited on two devices while offline: the category split, the
// amount and the accounts of one row, and the cached balances that follow
// them. A row is merged whole (last writer wins), so a split is never mixed
// from two devices, and the cache is rebuilt from the merged rows.

describe('transactions under sync', () => {
  let world: World
  let a: Device
  let b: Device
  let food: ShortId, office: ShortId, gifts: ShortId, fun: ShortId
  let wallet: ShortId
  let t: UUID

  beforeEach(async () => {
    ;[a, b] = (world = await openPair()).devices
  })

  afterEach(async () => {
    await world.close()
  })

  /** Four categories, a wallet and a 100.00 expense on Food. */
  const seedExpense = () =>
    start(world, async (d) => {
      food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      office = (await d.tags.create({ kind: 'category', name: 'Office' })).id
      gifts = (await d.tags.create({ kind: 'category', name: 'Gifts' })).id
      fun = (await d.tags.create({ kind: 'category', name: 'Fun' })).id
      wallet = await openAccount(d, 'Wallet')
      t = await record(d, { from: wallet, to: null, parts: [part(food, 10000)] })
    })

  describe.each([
    ['the device that syncs second', () => [a, b]],
    ['the device that syncs first', () => [b, a]],
  ] as const)('when %s edits last', (_, editors) => {
    it('keeps one whole row, amount and split, never a mix of the two', async () => {
      await seedExpense()
      const [early, late] = editors()
      at(minute(1))
      await early!.transactions.update(t, { categories: [part(food, 6000), part(office, 4000)] })
      at(minute(2))
      await late!.transactions.update(t, {
        amount__from: usd(12000),
        amount__to: usd(12000),
        categories: [part(gifts, 5000), part(fun, 7000)],
      })
      at(minute(3))
      await a.sync()
      at(minute(4))
      const onB = await b.sync()
      expect(onB.conflicts.map((c) => [c.table, c.primaryKey, c.resolution])).toEqual([
        ['transactions', t, 'latest-update-wins'],
      ])

      await settle([a, b], 5)
      for (const d of [a, b]) {
        expect((await d.transactions.findById(t))!.amount__from).toEqual(usd(12000))
        expect(await partsOf(d, t)).toEqual([
          [gifts, 5000, 2],
          [fun, 7000, 2],
        ])
      }
      await expectSound([a, b])
    })
  })

  it('redirects a newer split’s category that the other device merged', async () => {
    await start(world, async (d) => {
      food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      office = (await d.tags.create({ kind: 'category', name: 'Office' })).id
      gifts = (await d.tags.create({ kind: 'category', name: 'Gifts' })).id
      wallet = await openAccount(d, 'Wallet')
      t = await record(d, { from: wallet, to: null, parts: [part(food, 5000), part(office, 5000)] })
    })
    at(minute(1))
    await b.tags.merge(office, food) // B: Food 100.00
    at(minute(2))
    await a.transactions.update(t, { categories: [part(office, 3000), part(gifts, 7000)] })
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync() // A's newer split wins; its Office part moves to Food

    await settle([a, b], 5)
    for (const d of [a, b]) {
      expect(await partsOf(d, t)).toEqual([
        [food, 3000, 2],
        [gifts, 7000, 2],
      ])
    }
    await expectSound([a, b])
  })

  it('reports an older split that a newer merge overwrote', async () => {
    await start(world, async (d) => {
      food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      office = (await d.tags.create({ kind: 'category', name: 'Office' })).id
      gifts = (await d.tags.create({ kind: 'category', name: 'Gifts' })).id
      wallet = await openAccount(d, 'Wallet')
      t = await record(d, { from: wallet, to: null, parts: [part(food, 5000), part(office, 5000)] })
    })
    at(minute(1))
    await a.transactions.update(t, { categories: [part(office, 3000), part(gifts, 7000)] })
    at(minute(2))
    await b.tags.merge(office, food) // bumps the transaction: the merge is the later edit
    at(minute(3))
    await a.sync()
    at(minute(4))
    const onB = await b.sync()
    expect(onB.conflicts).toContainEqual(
      expect.objectContaining({ table: 'transactions', primaryKey: t, winner: 'local' }),
    )

    await settle([a, b], 5)
    for (const d of [a, b]) expect(await partsOf(d, t)).toEqual([[food, 10000, 2]])
    await expectSound([a, b])
  })

  describe('with a transfer', () => {
    let w1: ShortId, w2: ShortId, w3: ShortId, w4: ShortId, savings: ShortId

    const seedTransfer = () =>
      start(world, async (d) => {
        savings = (await d.tags.create({ kind: 'category', name: 'Savings' })).id
        w1 = await openAccount(d, 'Checking')
        w2 = await openAccount(d, 'Savings')
        w3 = await openAccount(d, 'Cash')
        w4 = await openAccount(d, 'Card')
        t = await record(d, { from: w1, to: w2, parts: [part(savings, 10000)] })
      })

    it('rebuilds every balance when both legs moved on different devices', async () => {
      await seedTransfer()
      at(minute(1))
      await a.transactions.update(t, { account_id__to: w3 })
      at(minute(2))
      await b.transactions.update(t, { account_id__from: w4 }) // the later row wins whole
      at(minute(3))
      await a.sync()
      at(minute(4))
      await b.sync()

      await settle([a, b], 5)
      for (const d of [a, b]) {
        expect(await balances(d)).toEqual({
          [w1]: [0, 2],
          [w2]: [10000, 2],
          [w3]: [0, 2],
          [w4]: [-10000, 2],
        })
      }
      await expectSound([a, b])
    })

    it('lets a delete win over an edit made after it', async () => {
      await seedTransfer()
      at(minute(1))
      await b.transactions.softDelete(t)
      at(minute(2))
      await a.transactions.update(t, {
        amount__from: usd(15000),
        amount__to: usd(15000),
        categories: [part(savings, 15000)],
      })
      at(minute(3))
      await a.sync()
      at(minute(4))
      await b.sync()

      await settle([a, b], 5)
      for (const d of [a, b]) {
        expect(await d.transactions.findById(t)).toBeNull()
        expect(Object.values(await balances(d)).map(([value]) => value)).toEqual([0, 0, 0, 0])
      }
      await expectSound([a, b])
    })
  })
})
