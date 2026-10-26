import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { AccountsRepository } from '../AccountsRepository'
import { AccountGroupingsRepository } from '../AccountGroupingsRepository'
import { moneyAmount } from '../../MoneyAmount'
import { asUuid, type UUID } from '../../uuid'
import { asShortId } from '../../shortId'

describe('AccountsRepository', () => {
  let db: Database
  let repo: AccountsRepository
  let groupings: AccountGroupingsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    repo = new AccountsRepository(db)
    groupings = new AccountGroupingsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates and finds an account', async () => {
    const account = await repo.create({
      name: 'Checking',
      balance: moneyAmount(10000, 2, 'USD'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#000',
      icon: 'bank',
    })
    expect(account.id).toBeDefined()
    expect(account.name).toBe('Checking')
    expect(account.balance.value).toBe(10000)
    expect(account.balance.scale).toBe(2)
    expect(account.balance.currency).toBe('USD')

    const found = await repo.findById(account.id)
    expect(found).not.toBeNull()
    expect(found?.name).toBe('Checking')
  })

  it('returns null for a missing account', async () => {
    expect(await repo.findById(asUuid('nonexistent'))).toBeNull()
  })

  it('round-trips balance MoneyAmount with scale=2', async () => {
    const account = await repo.create({
      name: 'USD Account',
      balance: moneyAmount(1234, 2, 'USD'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#FFF',
      icon: 'dollar',
    })
    const found = await repo.findById(account.id)
    expect(found?.balance.value).toBe(1234)
    expect(found?.balance.scale).toBe(2)
    expect(found?.balance.currency).toBe('USD')
  })

  it('round-trips balance MoneyAmount with scale=8 (crypto)', async () => {
    const account = await repo.create({
      name: 'Bitcoin Account',
      balance: moneyAmount(100000000, 8, 'BTC'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#F7931A',
      icon: 'bitcoin',
    })
    const found = await repo.findById(account.id)
    expect(found?.balance.value).toBe(100000000)
    expect(found?.balance.scale).toBe(8)
    expect(found?.balance.currency).toBe('BTC')
  })

  it('round-trips tags JSON array', async () => {
    const account = await repo.create({
      name: 'Tagged Account',
      balance: moneyAmount(5000, 2, 'USD'),
      tags: ['savings', 'emergency'],
      location_id: null,
      grouping_id: null,
      colour: '#0FF',
      icon: 'wallet',
    })
    const found = await repo.findById(account.id)
    expect(found?.tags).toEqual(['savings', 'emergency'])
  })

  it('is not cash unless told, and round-trips is_cash', async () => {
    const input = {
      name: 'Wallet',
      balance: moneyAmount(0, 2, 'EUR'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#0F0',
      icon: 'wallet',
    }
    const bank = await repo.create(input)
    expect(bank.is_cash).toBe(false)

    const wallet = await repo.create({ ...input, is_cash: true })
    expect((await repo.findById(wallet.id))?.is_cash).toBe(true)

    await repo.update(wallet.id, { is_cash: false })
    expect((await repo.findById(wallet.id))?.is_cash).toBe(false)
  })

  it('list() returns all non-deleted accounts', async () => {
    await repo.create({
      name: 'Account A',
      balance: moneyAmount(1000, 2, 'USD'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#000',
      icon: 'x',
    })
    await repo.create({
      name: 'Account B',
      balance: moneyAmount(2000, 2, 'USD'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#000',
      icon: 'x',
    })
    const list = await repo.list()
    expect(list).toHaveLength(2)
    expect(list.map((a) => a.name)).toEqual(['Account A', 'Account B'])
  })

  it('updates account and bumps updated_at_utc', async () => {
    const account = await repo.create({
      name: 'Original',
      balance: moneyAmount(1000, 2, 'USD'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#000',
      icon: 'bank',
    })
    const before = (await repo.findById(account.id))!
    await new Promise((r) => setTimeout(r, 5))
    await repo.update(account.id, { name: 'Updated', colour: '#FFF' })
    const after = (await repo.findById(account.id))!
    expect(after.name).toBe('Updated')
    expect(after.colour).toBe('#FFF')
    expect(after.updated_at_utc > before.updated_at_utc).toBe(true)
  })

  it('update changes only provided fields', async () => {
    const account = await repo.create({
      name: 'Test',
      balance: moneyAmount(1000, 2, 'USD'),
      tags: ['original'],
      location_id: null,
      grouping_id: null,
      colour: '#000',
      icon: 'bank',
    })
    await repo.update(account.id, { name: 'Changed' })
    const after = await repo.findById(account.id)
    expect(after?.name).toBe('Changed')
    expect(after?.tags).toEqual(['original'])
    expect(after?.colour).toBe('#000')
  })

  it('updates balance MoneyAmount', async () => {
    const account = await repo.create({
      name: 'Balance Test',
      balance: moneyAmount(1000, 2, 'USD'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#000',
      icon: 'bank',
    })
    await repo.update(account.id, { balance: moneyAmount(5000, 2, 'EUR') })
    const after = await repo.findById(account.id)
    expect(after?.balance.value).toBe(5000)
    expect(after?.balance.currency).toBe('EUR')
  })

  it('soft-deletes an account', async () => {
    const account = await repo.create({
      name: 'Temp Account',
      balance: moneyAmount(1000, 2, 'USD'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#000',
      icon: 'x',
    })
    await repo.softDelete(account.id)
    expect(await repo.findById(account.id)).toBeNull()
    const list = await repo.list()
    expect(list).toHaveLength(0)
  })

  describe('order and groups (grouping_id, sort_order)', () => {
    function createNamed(name: string, grouping_id: UUID | null = null) {
      return repo.create({
        name,
        balance: moneyAmount(0, 2, 'USD'),
        tags: [],
        location_id: null,
        grouping_id,
        colour: '#000',
        icon: 'wallet',
      })
    }

    const createGrouping = (name: string) =>
      groupings.create({ name, colour: '#000', icon: 'folder' })

    const namesIn = async (groupingId: UUID | null) =>
      (await repo.list()).filter((a) => a.grouping_id === groupingId).map((a) => a.name)

    it('appends a new account after the existing ones', async () => {
      const first = await createNamed('Zeta')
      const second = await createNamed('Alpha')
      expect(first.sort_order).toBe(0)
      expect(second.sort_order).toBe(1)
      // Creation order, not alphabetical.
      expect((await repo.list()).map((a) => a.name)).toEqual(['Zeta', 'Alpha'])
    })

    it('appends after the highest position even when it belongs to a deleted account', async () => {
      await createNamed('A')
      const b = await createNamed('B')
      await repo.softDelete(b.id)
      const c = await createNamed('C')
      expect(c.sort_order).toBe(2)
    })

    it('appends within the account’s own group', async () => {
      const trip = await createGrouping('Trip')
      await createNamed('Loose 1')
      await createNamed('Loose 2')
      const card = await createNamed('Card', trip.id)
      expect(card.grouping_id).toBe(trip.id)
      expect(card.sort_order).toBe(0)
      expect((await createNamed('Cash', trip.id)).sort_order).toBe(1)
    })

    it('rejects a group that does not exist', async () => {
      await expect(createNamed('Orphan', asUuid('no-such-grouping'))).rejects.toThrow()
    })

    it('arrange() stores the given order', async () => {
      const a = await createNamed('A')
      const b = await createNamed('B')
      const c = await createNamed('C')
      await repo.arrange(null, [c.id, a.id, b.id])
      expect(await namesIn(null)).toEqual(['C', 'A', 'B'])
    })

    it('arrange() bumps updated_at_utc only on accounts whose place changed', async () => {
      const a = await createNamed('A')
      const b = await createNamed('B')
      const c = await createNamed('C')
      await new Promise((r) => setTimeout(r, 5))
      await repo.arrange(null, [a.id, c.id, b.id])
      const after = new Map((await repo.list()).map((x) => [x.name, x]))
      expect(after.get('A')!.updated_at_utc).toEqual(a.updated_at_utc)
      expect(after.get('B')!.updated_at_utc > b.updated_at_utc).toBe(true)
      expect(after.get('C')!.updated_at_utc > c.updated_at_utc).toBe(true)
    })

    it('arrange() moves accounts into another group at the given place', async () => {
      const trip = await createGrouping('Trip')
      const loose = await createNamed('Loose')
      const card = await createNamed('Card', trip.id)
      const cash = await createNamed('Cash', trip.id)
      await repo.arrange(trip.id, [card.id, loose.id, cash.id])
      expect(await namesIn(trip.id)).toEqual(['Card', 'Loose', 'Cash'])
      expect(await namesIn(null)).toEqual([])
    })

    it('arrange() moves an account out of its group', async () => {
      const trip = await createGrouping('Trip')
      const card = await createNamed('Card', trip.id)
      // Same position (0) as before, but a different group: still written.
      await repo.arrange(null, [card.id])
      expect((await repo.findById(card.id))!.grouping_id).toBeNull()
    })

    it('list() breaks equal positions by name', async () => {
      // Two devices can each append an account at the same position; the merge
      // keeps both rows, so equal values must still list deterministically.
      const b = await createNamed('B')
      const a = await createNamed('A')
      await db.run('UPDATE accounts SET sort_order = 0 WHERE id IN (?, ?)', [a.id, b.id])
      expect((await repo.list()).map((x) => x.name)).toEqual(['A', 'B'])
    })

    it('update() leaves the position alone', async () => {
      await createNamed('A')
      const b = await createNamed('B')
      await repo.update(b.id, { name: 'B2' })
      expect((await repo.findById(b.id))!.sort_order).toBe(1)
    })

    it('update() with a new group puts the account at the end of that group', async () => {
      const trip = await createGrouping('Trip')
      await createNamed('Card', trip.id)
      await createNamed('Loose 1')
      const moved = await createNamed('Loose 2')
      await repo.update(moved.id, { grouping_id: trip.id, name: 'Moved' })
      const after = (await repo.findById(moved.id))!
      expect(after).toMatchObject({ grouping_id: trip.id, sort_order: 1, name: 'Moved' })
      expect(await namesIn(trip.id)).toEqual(['Card', 'Moved'])
    })

    it('update() with the same group leaves the position alone', async () => {
      const trip = await createGrouping('Trip')
      const card = await createNamed('Card', trip.id)
      await createNamed('Cash', trip.id)
      await repo.update(card.id, { grouping_id: trip.id })
      expect((await repo.findById(card.id))!.sort_order).toBe(0)
    })
  })

  it('throws when creating with non-existent location_id (FK violation)', async () => {
    await expect(
      repo.create({
        name: 'Bad Location',
        balance: moneyAmount(1000, 2, 'USD'),
        tags: [],
        location_id: asShortId('nonexistent-location-id'),
        grouping_id: null,
        colour: '#000',
        icon: 'bank',
      }),
    ).rejects.toThrow()
  })
})
