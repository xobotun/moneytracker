import { describe, it, expect, afterEach } from 'vitest'
import type { ShortId } from '../../../db/shortId'
import {
  at,
  minute,
  openPair,
  settle,
  start,
  type BackendKind,
  type Device,
  type World,
} from '../devices'
import { expectSound, openAccount, part, record } from './fixtures'

// Archiving a tag or an account (ideas, must-haves 1 and 2) is an ordinary
// edit of its row: the stamp travels like any other column, through both
// backends, and an archived tag stays valid on what uses it, so a device that
// used it offline meanwhile conflicts with nothing.

let world: World

afterEach(async () => {
  await world.close()
})

/** The row's archive stamp as stored. */
async function archivedAt(device: Device, table: 'tags' | 'accounts', id: string) {
  const rows = await device.db.exec<{ archived_at_utc: string | null }>(
    `SELECT archived_at_utc FROM ${table} WHERE id = ?`,
    [id],
  )
  return rows[0]!.archived_at_utc
}

describe.each<BackendKind>(['memory', 'github'])('archiving through the %s backend', (kind) => {
  it('reaches the other device, and so does unarchiving', async () => {
    const [a, b] = (world = await openPair(kind)).devices
    let rewe!: ShortId, card!: ShortId
    await start(world, async (device) => {
      rewe = (await device.tags.create({ kind: 'merchant', name: 'Rewe' })).id
      card = await openAccount(device, 'Card')
    })

    at(minute(1))
    await a.tags.archive(rewe)
    await a.accounts.archive(card)
    await a.sync()
    at(minute(2))
    await b.sync()
    for (const d of [a, b]) {
      expect(await archivedAt(d, 'tags', rewe), `tag on ${d.name}`).toBe(minute(1))
      expect(await archivedAt(d, 'accounts', card), `account on ${d.name}`).toBe(minute(1))
    }

    at(minute(3))
    await b.tags.unarchive(rewe)
    await b.accounts.unarchive(card)
    await b.sync()
    at(minute(4))
    await a.sync()
    for (const d of [a, b]) {
      expect(await archivedAt(d, 'tags', rewe), `tag on ${d.name}`).toBeNull()
      expect(await archivedAt(d, 'accounts', card), `account on ${d.name}`).toBeNull()
    }
    await settle([a, b], 5)
  })
})

describe('archiving while the other device uses it', () => {
  it('keeps the archived category and account on a transaction recorded offline', async () => {
    const [a, b] = (world = await openPair()).devices
    let food!: ShortId, card!: ShortId
    await start(world, async (device) => {
      food = (await device.tags.create({ kind: 'category', name: 'Food' })).id
      card = await openAccount(device, 'Card')
    })

    at(minute(1))
    await a.tags.archive(food)
    await a.accounts.archive(card)
    at(minute(2))
    const lunch = await record(b, { from: card, to: null, parts: [part(food, 1250)] })
    at(minute(3))
    expect((await a.sync()).conflicts).toEqual([])
    at(minute(4))
    expect((await b.sync()).conflicts).toEqual([])

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await archivedAt(d, 'tags', food)).toBe(minute(1))
      expect(await archivedAt(d, 'accounts', card)).toBe(minute(1))
      expect((await d.transactions.findById(lunch))!.categories[0]!.category_id).toBe(food)
      expect((await d.accounts.findById(card))!.balance.value).toBe(-1250)
    }
  })
})
