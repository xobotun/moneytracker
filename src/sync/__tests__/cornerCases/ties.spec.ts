import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { asShortId, type ShortId } from '../../../db/shortId'
import { at, minute, openPair, settle, start, T0, type Device, type World } from '../devices'
import { seedTag } from '../helpers'
import { expectSound, openAccount, tagRow } from './fixtures'

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
})
