import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { asShortId, type ShortId } from '../../../db/shortId'
import type { UUID } from '../../../db/uuid'
import { at, minute, openPair, settle, start, T0, type Device, type World } from '../devices'
import { seedTag } from '../helpers'
import { expectSound, openAccount, part, partsOf, record, tagRow } from './fixtures'

// Clock ties: both devices change the same rows in the same millisecond.
// Every rule that orders by time needs a tie-break both devices apply alike:
// conflicts go to the row whose content sorts greater, repairs to the
// greatest id. Ids are fixed here, and both id orders run, so each branch
// is taken on purpose.

const LOW = asShortId('000000000001')
const HIGH = asShortId('000000000002')
const ORDERS = [
  ['A acts on the lower id', LOW, HIGH],
  ['A acts on the higher id', HIGH, LOW],
] as const

describe('clock ties between two devices', () => {
  let world: World
  let a: Device
  let b: Device

  beforeEach(async () => {
    ;[a, b] = (world = await openPair()).devices
  })

  afterEach(async () => {
    await world.close()
  })

  /** Two top-level plain tags with the fixed ids. */
  const seedPair = async (d: Device) => {
    await Promise.all([
      seedTag(d.db, { id: LOW, name: 'low', kind: 'tag', created: T0, updated: T0 }),
      seedTag(d.db, { id: HIGH, name: 'high', kind: 'tag', created: T0, updated: T0 }),
    ])
  }

  it('keeps the same one of two renames made in the same millisecond', async () => {
    await start(world, seedPair)
    at(minute(1))
    await a.tags.update(LOW, { name: 'Alpha' })
    await b.tags.update(LOW, { name: 'Beta' })
    at(minute(2))
    await a.sync()
    at(minute(3))
    const onB = await b.sync()
    expect(onB.conflicts.map((c) => [c.primaryKey, c.resolution])).toEqual([
      [LOW, 'latest-update-wins'],
    ])

    await settle([a, b], 4)
    // The tie goes to the row whose content sorts greater: "Beta".
    for (const d of [a, b]) expect(await tagRow(d, LOW)).toMatchObject({ name: 'Beta' })
  })

  it('keeps one whole split of two made in the same millisecond', async () => {
    const cat = (n: number) => asShortId(`00000000000${n}`.slice(-12))
    let t!: UUID
    await start(world, async (d) => {
      for (const n of [3, 4, 5, 6]) {
        await seedTag(d.db, {
          id: cat(n),
          name: `c${n}`,
          kind: 'category',
          created: T0,
          updated: T0,
        })
      }
      const wallet = await openAccount(d, 'Wallet')
      t = await record(d, { from: wallet, to: null, parts: [part(cat(3), 10000)] })
    })
    at(minute(1))
    await a.transactions.update(t, { categories: [part(cat(3), 6000), part(cat(4), 4000)] })
    await b.transactions.update(t, { categories: [part(cat(5), 3000), part(cat(6), 7000)] })
    at(minute(2))
    await a.sync()
    at(minute(3))
    await b.sync()

    await settle([a, b], 4)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await partsOf(d, t)).toEqual([
        [cat(5), 3000, 2],
        [cat(6), 7000, 2],
      ])
    }
  })

  it.each(ORDERS)(
    'undoes the move of the greater id in a loop made in the same millisecond (%s)',
    async (_, onA, onB) => {
      await start(world, seedPair)
      at(minute(1))
      await a.tags.move(onA, onB)
      await b.tags.move(onB, onA)
      at(minute(2))
      await a.sync()
      at(minute(3))
      const outcome = await b.sync()
      expect(outcome.conflicts.map((c) => [c.primaryKey, c.resolution])).toEqual([
        [HIGH, 'loop-undone'],
      ])

      await settle([a, b], 4)
      await expectSound([a, b])
      for (const d of [a, b]) {
        expect(await tagRow(d, HIGH)).toMatchObject({ parent_id: null })
        expect(await tagRow(d, LOW)).toMatchObject({ parent_id: HIGH })
      }
    },
  )

  it.each(ORDERS)(
    'restores the greater id of a merge cycle made in the same millisecond (%s)',
    async (_, onA, onB) => {
      let account!: ShortId
      await start(world, async (d) => {
        await seedPair(d)
        account = await openAccount(d, 'Wallet')
        await d.accounts.update(account, { tags: [LOW, HIGH] })
      })
      at(minute(1))
      await a.tags.merge(onA, onB)
      await b.tags.merge(onB, onA)
      at(minute(2))
      await a.sync()
      at(minute(3))
      await b.sync()

      await settle([a, b], 4)
      await expectSound([a, b])
      for (const d of [a, b]) {
        expect(await tagRow(d, HIGH)).toMatchObject({ deleted_at_utc: null, merged_into_id: null })
        expect(await tagRow(d, LOW)).toMatchObject({ merged_into_id: HIGH })
        expect((await d.accounts.findById(account))!.tags).toEqual([HIGH])
      }
    },
  )

  it.each(ORDERS)(
    'converges on a merge and a plain delete of one tag in the same millisecond (%s)',
    async (_, source, target) => {
      await start(world, seedPair)
      at(minute(1))
      await a.tags.merge(source, target)
      await b.tags.softDelete(source)
      at(minute(2))
      await a.sync()
      at(minute(3))
      await b.sync()

      await settle([a, b], 4)
      await expectSound([a, b])
      for (const d of [a, b]) {
        expect(await tagRow(d, source)).toMatchObject({ deleted_at_utc: minute(1) })
        expect(await tagRow(d, target)).toMatchObject({ deleted_at_utc: null })
      }
    },
  )
})
