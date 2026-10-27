import { describe, it, expect, afterEach } from 'vitest'
import { asShortId, type ShortId } from '../../../db/shortId'
import type { UUID } from '../../../db/uuid'
import { exportAllTables, importAllTables } from '../../csvCodec'
import { hashDatabase } from '../../hashDatabase'
import {
  at,
  minute,
  openPair,
  openTrio,
  settle,
  start,
  T0,
  type Device,
  type World,
} from '../devices'
import { newMigratedDb, seedTag } from '../helpers'
import { expectSound, openAccount, part, record, tagRow } from './fixtures'

// The GitHub backend stores the database as CSV files: every upload exports
// the tables and every download imports them into a fresh database, child
// tags possibly before their parents (rows are in id order). These scenarios
// sync through it, or round-trip a database caught in the middle of a
// scenario, and compare by the database hash.

let world: World

afterEach(async () => {
  await world.close()
})

const id = (n: number) => asShortId(String(n).padStart(12, '0'))

/** The device's database exported to CSV and imported into a fresh one: same hash. */
async function expectCsvRoundTrip(device: Device): Promise<void> {
  const copy = await newMigratedDb()
  try {
    await importAllTables(copy, await exportAllTables(device.db))
    expect(await hashDatabase(copy), `${device.name} through CSV`).toBe(
      await hashDatabase(device.db),
    )
  } finally {
    await copy.close()
  }
}

describe('through the GitHub backend', () => {
  it('lifts a child whose id sorts before its parent’s and its deleted parent’s', async () => {
    const [a, b] = (world = await openPair('github')).devices
    // Each child's id sorts before its parent's: 1 under 2 under 3.
    await start(world, async ({ db }) => {
      const tag = (n: number, parent: number | null) =>
        seedTag(db, {
          id: id(n),
          name: `L${n}`,
          parentId: parent === null ? null : id(parent),
          created: T0,
          updated: T0,
        })
      await tag(3, null)
      await tag(2, 3)
      await tag(1, 2)
    })
    at(minute(1))
    await b.tags.softDelete(id(2)) // B moves L1 up to L3
    at(minute(2))
    const fresh = (await a.tags.create({ kind: 'location', name: 'new', parent_id: id(2) })).id
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync() // the new tag arrives under the deleted L2: lifted to L3

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await tagRow(d, id(1))).toMatchObject({ parent_id: id(3) })
      expect(await tagRow(d, fresh)).toMatchObject({ parent_id: id(3) })
    }
  })

  it("keeps optional text that is '' as NULL on every device", async () => {
    const [a, b] = (world = await openPair('github')).devices
    let tag!: ShortId
    await start(world, async (d) => {
      tag = (await d.tags.create({ kind: 'tag', name: 'old' })).id
    })
    // As an older version, or a raw import, may write it. The repositories
    // store '' as NULL (optionalTextToColumn): a CSV cell cannot tell them
    // apart, so the other device gets NULL, and the tie goes to NULL on A.
    await a.db.run(
      `UPDATE tags SET description = '', colour = '', updated_at_utc = ? WHERE id = ?`,
      [minute(1), tag],
    )

    await settle([a, b], 2)
    for (const d of [a, b]) {
      expect(await tagRow(d, tag)).toMatchObject({ description: null, colour: null })
    }
  })

  it('carries non-ASCII names, quotes and line breaks in JSON and text columns', async () => {
    const [a, b] = (world = await openPair('github')).devices
    const synonyms = ['ВкусВилл', 'Café "Zum Löwen", Ecke', 'emoji 😀', 'line\nbreak', ' spaced ']
    const auto = { text: 'Grüße\r\nzweite Zeile, "quoted"', amount: '1,00 €', nested: { ok: true } }
    let shop!: ShortId, t!: UUID
    await start(world, async (d) => {
      shop = (await d.tags.create({ kind: 'merchant', name: 'Вкусвилл', synonyms })).id
      const food = (await d.tags.create({ kind: 'category', name: 'Еда, "всё"' })).id
      const wallet = await openAccount(d, 'Кошелёк')
      t = await record(d, { from: wallet, to: null, parts: [part(food, 4250)], merchant: shop })
      await d.transactions.update(t, {
        description__user: ' Bäckerei, "Brot"\nund Kuchen ',
        description__auto: auto,
      })
    })
    at(minute(1))
    await b.tags.update(shop, { synonyms: [...synonyms, 'ВВ'] })

    await settle([a, b], 2)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect((await d.tags.findById(shop))!.synonyms).toEqual([...synonyms, 'ВВ'])
      expect(await d.transactions.findById(t)).toMatchObject({
        description__user: ' Bäckerei, "Brot"\nund Kuchen ',
        description__auto: auto,
      })
    }
  })
})

describe('a database caught in the middle of a scenario', () => {
  it('round-trips through CSV after every sync of a merge cycle, a lift and a loop', async () => {
    const [a, b, c] = (world = await openTrio()).devices
    let x!: ShortId, y!: ShortId, p!: ShortId, q!: ShortId, child!: ShortId
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'category', name: 'Clothes' })).id
      y = (await d.tags.create({ kind: 'category', name: 'Apparel' })).id
      p = (await d.tags.create({ kind: 'category', name: 'Home' })).id
      q = (await d.tags.create({ kind: 'category', name: 'Garden' })).id
      child = (await d.tags.create({ kind: 'category', name: 'Tools', parent_id: q })).id
      const wallet = await openAccount(d, 'Wallet')
      await record(d, { from: wallet, to: null, parts: [part(x, 1000), part(y, 2000)] })
    })
    at(minute(1))
    await a.tags.merge(x, y)
    await a.tags.move(p, child) // with C's move of q under p: a loop
    at(minute(2))
    await b.tags.merge(y, x) // a merge cycle with A's
    await b.tags.softDelete(child) // A's p arrives under it: lifted
    at(minute(3))
    await c.tags.move(q, p)

    let step = 4
    for (const d of [a, b, c, a, b, c]) {
      at(minute(step++))
      await d.sync()
      for (const each of [a, b, c]) await expectCsvRoundTrip(each)
    }
    await settle([a, b, c], step)
    await expectSound([a, b, c])
    for (const d of [a, b, c]) {
      expect(await tagRow(d, x)).toMatchObject({ merged_into_id: y })
      expect(await tagRow(d, y)).toMatchObject({ deleted_at_utc: null })
      expect(await tagRow(d, p)).toMatchObject({ parent_id: q, deleted_at_utc: null })
      expect(await tagRow(d, q)).toMatchObject({ parent_id: null, deleted_at_utc: null })
    }
  })
})
