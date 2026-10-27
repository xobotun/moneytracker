import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { UUID } from '../../../db/uuid'
import type { SyncConflict } from '../../types'
import { at, minute, openPair, settle, start, type Device, type World } from '../devices'
import { expectSound, openAccount, part, record } from './fixtures'

// A change made offline is uploaded later than it was made: when the other
// device uploaded something in between, the change predates that device's
// last sync. A timestamp cutoff (the upload time of the last sync) took such a
// change for old, and the rules that do not go by time alone — delete wins,
// rank wins — never ran. The sync base (src/sync/syncBase.ts) sees a change by
// the row's hash, whatever its timestamps say. These scenarios pin that the
// rules apply to a change made offline.

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

  // B deletes the transaction at minute 1 and uploads it at minute 4. A, which
  // uploaded at minute 3 and has not seen the delete, edits the transaction at
  // minute 5. The delete (minute 1) predates A's last sync, but it differs from
  // A's base: both sides changed the row, so the delete wins and A reports the
  // edit it discarded (the lost delete of
  // docs/plans/2026-10-26-sync-change-detection.md §1).
  it('lets the delete win over an edit made after the other device’s cutoff', async () => {
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

  // The same for rank: B's manual rate (minute 1, uploaded at minute 4)
  // predates A's last sync (minute 3); A's resolver then upgrades its own row
  // to a central bank's rate (minute 5). Both sides changed the row since A's
  // base, so the rank decides: ROW_RANK (src/sync/syncColumns.ts) keeps the
  // override over a device that resolved the same day.
  it('keeps a manual rate over a resolution made after the other device’s cutoff', async () => {
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
  })

  it('lets the delete win when the edit predates the other device’s cutoff', async () => {
    // The control: the same edit made before B's upload at minute 4, which a
    // cutoff also got right (both rows looked unchanged, and resolveConflict
    // decided). The base sees both sides changed, and the delete wins alike.
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
