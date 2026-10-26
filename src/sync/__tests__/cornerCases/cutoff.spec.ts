import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { UUID } from '../../../db/uuid'
import type { SyncConflict } from '../../types'
import { at, minute, openPair, settle, start, type Device, type World } from '../devices'
import { expectSound, openAccount, part, record } from './fixtures'

// The merge cutoff is the upload time of the device's own last sync, so a
// change counts as "changed" on the other side only when its timestamp is
// later. A change made offline is uploaded later than it was made: when the
// other device uploaded something in between, the change predates that
// device's cutoff and looks old there. These scenarios pin what that does to
// the rules that do not go by time alone: delete wins, and rank wins.

describe('changes made offline before the other device’s cutoff', () => {
  let world: World
  let a: Device
  let b: Device

  beforeEach(async () => {
    ;[a, b] = (world = await openPair()).devices
  })

  afterEach(async () => {
    await world.close()
  })

  /** A uploads an unrelated change at minute 3, so A's cutoff moves past minute 1. */
  async function aUploadsSomethingElse(): Promise<void> {
    at(minute(2))
    await a.tags.create({ kind: 'tag', name: 'unrelated' })
    at(minute(3))
    expect((await a.sync()).decision).toBe('merge')
  }

  const conflictsOf = (all: SyncConflict[], key: string) => all.filter((c) => c.primaryKey === key)

  // BUG: B deletes the transaction at minute 1 and uploads it at minute 4. A,
  // which uploaded at minute 3 and has not seen the delete, edits the
  // transaction at minute 5. On A's merge the remote delete (minute 1) is not
  // "changed since" A's cutoff (minute 3), so the local edit is kept without
  // a conflict (src/sync/mergeEngine.ts, "Only the local moved"); on B the
  // edit (minute 5) is "changed since" B's cutoff (minute 4) and replaces the
  // tombstone. The delete is lost on both devices, silently — the scenarios
  // doc says the delete wins and every discarded change is reported.
  it.fails('lets the delete win over an edit made after the other device’s cutoff', async () => {
    let t!: UUID
    await start(world, async (d) => {
      const food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      const wallet = await openAccount(d, 'Wallet')
      t = await record(d, { from: wallet, to: null, parts: [part(food, 1999)] })
    })
    at(minute(1))
    await b.transactions.softDelete(t)
    await aUploadsSomethingElse()
    at(minute(4))
    expect((await b.sync()).decision).toBe('merge')
    at(minute(5))
    await a.transactions.update(t, { description__user: 'lunch with Mia' })
    at(minute(6))
    const onA = await a.sync()
    at(minute(7))
    const onB = await b.sync()

    await settle([a, b], 8)
    await expectSound([a, b])
    for (const d of [a, b]) expect(await d.transactions.findById(t)).toBeNull()
    expect([...conflictsOf(onA.conflicts, t), ...conflictsOf(onB.conflicts, t)]).not.toEqual([])
  })

  // BUG: the same for rank: B's manual rate (minute 1, uploaded at minute 4)
  // predates A's cutoff (minute 3); A's resolver then upgrades its own row to
  // a central bank's rate (minute 5). A keeps its row as "only local moved",
  // B takes it as "only remote moved", and the override is gone on both —
  // ROW_RANK (src/sync/syncColumns.ts) promises "an override is never lost to
  // a device that resolved the same day", but the rank is only consulted when
  // both sides changed since the cutoff (src/sync/mergeEngine.ts).
  it.fails(
    'keeps a manual rate over a resolution made after the other device’s cutoff',
    async () => {
      const day = '2026-04-30'
      await start(world, async (d) => {
        await d.rates.saveAuto({
          date: day,
          x: 'EUR',
          y: 'USD',
          resolution: { rate: 1.1, provider: 'fawazahmed0', via: null, referenceDate: day },
        })
      })
      at(minute(1))
      await b.rates.setManual(day, 'EUR', 'USD', 1.25)
      await aUploadsSomethingElse()
      at(minute(4))
      await b.sync()
      at(minute(5))
      expect(
        await a.rates.saveAuto({
          date: day,
          x: 'EUR',
          y: 'USD',
          resolution: { rate: 1.12, provider: 'ecb', via: null, referenceDate: day },
        }),
      ).toBe(true)
      at(minute(6))
      await a.sync()
      at(minute(7))
      await b.sync()

      await settle([a, b], 8)
      for (const d of [a, b]) {
        expect(await d.rates.find(day, 'EUR', 'USD')).toMatchObject({
          provider: 'manual',
          rate: 1.25,
        })
      }
    },
  )

  it('lets the delete win when the edit predates the other device’s cutoff', async () => {
    // The control: the same edit made before B's upload at minute 4 looks
    // old to B too, so both rows "did not change" and resolveConflict decides.
    let t!: UUID
    await start(world, async (d) => {
      const food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      const wallet = await openAccount(d, 'Wallet')
      t = await record(d, { from: wallet, to: null, parts: [part(food, 1999)] })
    })
    at(minute(1))
    await b.transactions.softDelete(t)
    await aUploadsSomethingElse()
    at(minute(3.5))
    await a.transactions.update(t, { description__user: 'lunch with Mia' })
    at(minute(4))
    await b.sync()
    at(minute(6))
    await a.sync()
    at(minute(7))
    await b.sync()

    await settle([a, b], 8)
    await expectSound([a, b])
    for (const d of [a, b]) expect(await d.transactions.findById(t)).toBeNull()
  })
})
