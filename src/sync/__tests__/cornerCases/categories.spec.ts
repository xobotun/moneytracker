import { describe, it, expect, afterEach } from 'vitest'
import type { ShortId } from '../../../db/shortId'
import type { UUID } from '../../../db/uuid'
import { at, minute, openPair, openTrio, settle, start, type World } from '../devices'
import {
  expectSound,
  openAccount,
  part,
  partsOf,
  record,
  tagRow,
  transactionsWithoutLiveCategory,
} from './fixtures'

// "Every transaction has at least one category" (decisions §2.2): a category
// in use cannot be deleted, only merged into another one (§2.5). Each device
// checks that against its own rows; these scenarios bring a transaction and
// a category's delete or merge together from different devices.

describe('categories deleted or merged elsewhere', () => {
  let world: World

  afterEach(async () => {
    await world.close()
  })

  // B's transaction arrives on a category A deleted while it was unused
  // there. A category in use cannot be deleted (§2.5), so the repair undoes
  // the delete (src/sync/repairTags.ts, "categories in use").
  it('keeps a live category on a transaction recorded on a category deleted elsewhere', async () => {
    const [a, b] = (world = await openPair()).devices
    let fun!: ShortId, wallet!: ShortId
    await start(world, async (d) => {
      await d.tags.create({ kind: 'category', name: 'Food' })
      fun = (await d.tags.create({ kind: 'category', name: 'Fun' })).id
      wallet = await openAccount(d, 'Wallet')
    })
    at(minute(1))
    await a.tags.softDelete(fun) // unused on A: allowed
    at(minute(2))
    await record(b, { from: wallet, to: null, parts: [part(fun, 2500)] })
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync()

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) expect(await transactionsWithoutLiveCategory(d)).toEqual([])
  })

  // As above, but B also renamed the category before recording on it. Delete
  // wins and keeps A's tombstone, named "Fun"; the repair restores the
  // category as B, where it was live, had it — so the rename is not lost.
  it('keeps the other device’s rename of a category in use that was deleted elsewhere', async () => {
    const [a, b] = (world = await openPair()).devices
    let fun!: ShortId, wallet!: ShortId
    await start(world, async (d) => {
      await d.tags.create({ kind: 'category', name: 'Food' })
      fun = (await d.tags.create({ kind: 'category', name: 'Fun' })).id
      wallet = await openAccount(d, 'Wallet')
    })
    at(minute(1))
    await a.tags.softDelete(fun) // unused on A: allowed
    at(minute(2))
    await b.tags.update(fun, { name: 'Leisure' })
    at(minute(3))
    await record(b, { from: wallet, to: null, parts: [part(fun, 2500)] })
    at(minute(4))
    await a.sync()
    at(minute(5))
    await b.sync()

    await settle([a, b], 6)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await tagRow(d, fun)).toMatchObject({
        name: 'Leisure',
        deleted_at_utc: null,
        updated_at_utc: minute(2),
      })
      expect(await transactionsWithoutLiveCategory(d)).toEqual([])
    }
  })

  // A merges X into Y while B deletes the unused Y. Delete wins on Y, and the
  // repair redirects X's transactions to the end of its merge chain, the
  // deleted Y — which they now use, so its delete is undone.
  it('keeps a live category on transactions merged into a category deleted elsewhere', async () => {
    const [a, b] = (world = await openPair()).devices
    let x!: ShortId, y!: ShortId, t!: UUID
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'category', name: 'Clothes' })).id
      y = (await d.tags.create({ kind: 'category', name: 'Apparel' })).id
      const wallet = await openAccount(d, 'Wallet')
      t = await record(d, { from: wallet, to: null, parts: [part(x, 6000)] })
    })
    at(minute(1))
    await b.tags.softDelete(y) // unused on B: allowed
    at(minute(2))
    await a.tags.merge(x, y)
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync()

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await partsOf(d, t)).toEqual([[y, 6000, 2]])
      expect(await transactionsWithoutLiveCategory(d)).toEqual([])
    }
  })

  it('moves a transaction recorded offline on a merged category, summing its parts', async () => {
    const [a, b, c] = (world = await openTrio()).devices
    let food!: ShortId, groceries!: ShortId, wallet!: ShortId
    await start(world, async (d) => {
      food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      groceries = (await d.tags.create({ kind: 'category', name: 'Groceries' })).id
      wallet = await openAccount(d, 'Wallet')
    })
    at(minute(1))
    await a.tags.merge(groceries, food)
    at(minute(2))
    const t = await record(c, {
      from: wallet,
      to: null,
      parts: [part(groceries, 3000), part(food, 7000)],
    })
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync()
    at(minute(5))
    await c.sync()

    await settle([a, b, c], 6)
    for (const d of [a, b, c]) expect(await partsOf(d, t)).toEqual([[food, 10000, 2]])
    await expectSound([a, b, c])
  })

  // B merges X into Y; A, later, deletes X (unused on A). Both rows are
  // deleted, and a merged tombstone outranks a plain one (ROW_RANK.tags), so
  // X keeps its merged_into_id however late the plain delete: C's transaction
  // recorded on X offline is redirected to Y (§2.5: "X ... remembers Y, so a
  // device that used X before it synced the merge is redirected to Y").
  it('redirects to the merge target even when a plain delete of the source is later', async () => {
    const [a, b, c] = (world = await openTrio()).devices
    let x!: ShortId, y!: ShortId, wallet!: ShortId
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'category', name: 'Eating out' })).id
      y = (await d.tags.create({ kind: 'category', name: 'Restaurants' })).id
      wallet = await openAccount(d, 'Wallet')
    })
    at(minute(1))
    await b.tags.merge(x, y)
    at(minute(2))
    await a.tags.softDelete(x)
    at(minute(3))
    const t = await record(c, { from: wallet, to: null, parts: [part(x, 4200)] })
    at(minute(4))
    await b.sync()
    at(minute(5))
    await a.sync()
    at(minute(6))
    await c.sync()

    await settle([a, b, c], 7)
    for (const d of [a, b, c]) expect(await partsOf(d, t)).toEqual([[y, 4200, 2]])
    await expectSound([a, b, c])
  })

  it('redirects a location’s merchant and a merchant’s default category merged elsewhere', async () => {
    const [a, b] = (world = await openPair()).devices
    let rewe!: ShortId, reweMarkt!: ShortId, alex!: ShortId, groceries!: ShortId, food!: ShortId
    await start(world, async (d) => {
      rewe = (await d.tags.create({ kind: 'merchant', name: 'Rewe' })).id
      reweMarkt = (await d.tags.create({ kind: 'merchant', name: 'REWE Markt' })).id
      alex = (await d.tags.create({ kind: 'location', name: 'Alexanderplatz' })).id
      groceries = (await d.tags.create({ kind: 'category', name: 'Groceries' })).id
      food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
    })
    at(minute(1))
    await b.tags.merge(reweMarkt, rewe)
    await b.tags.merge(groceries, food)
    at(minute(2))
    await a.details.setLocation(alex, {
      address: 'Alexanderplatz 1',
      latitude: 52.5219,
      longitude: 13.4132,
      merchant_id: reweMarkt,
    })
    const lidl = (await a.tags.create({ kind: 'merchant', name: 'Lidl' })).id
    await a.details.setMerchant(lidl, { default_category_id: groceries })
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync()

    await settle([a, b], 5)
    for (const d of [a, b]) {
      expect((await d.details.getLocation(alex))!.merchant_id).toBe(rewe)
      expect((await d.details.getMerchant(lidl))!.default_category_id).toBe(food)
    }
    await expectSound([a, b])
  })
})
