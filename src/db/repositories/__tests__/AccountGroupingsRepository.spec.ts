import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { AccountGroupingsRepository } from '../AccountGroupingsRepository'
import { AccountsRepository } from '../AccountsRepository'
import { zeroMoney } from '../../MoneyAmount'
import { asShortId, type ShortId } from '../../shortId'

describe('AccountGroupingsRepository', () => {
  let db: Database
  let repo: AccountGroupingsRepository
  let accounts: AccountsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    repo = new AccountGroupingsRepository(db)
    accounts = new AccountsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  function createNamed(name: string) {
    return repo.create({ name, colour: '#000000', icon: primeIcon('folder') })
  }

  function createAccount(name: string, grouping_id: ShortId | null) {
    return accounts.create({
      name,
      balance: zeroMoney('EUR'),
      tags: [],
      location_id: null,
      colour: '#000000',
      icon: primeIcon('wallet'),
      grouping_id,
    })
  }

  it('creates and finds an account grouping', async () => {
    const grouping = await repo.create({
      name: 'My Accounts',
      colour: '#FF5733',
      icon: primeIcon('wallet'),
    })
    expect(grouping.id).toMatch(/^[0-9A-Za-z]{12}$/)
    expect(grouping.name).toBe('My Accounts')
    expect(grouping.colour).toBe('#FF5733')
    expect(grouping.icon).toEqual(primeIcon('wallet'))

    const found = await repo.findById(grouping.id)
    expect(found).not.toBeNull()
    expect(found?.name).toBe('My Accounts')
  })

  it('returns null for a missing account grouping', async () => {
    expect(await repo.findById(asShortId('nonexistent'))).toBeNull()
  })

  it('appends a new grouping after the existing ones', async () => {
    const first = await createNamed('Zeta')
    const second = await createNamed('Alpha')
    expect(first.sort_order).toBe(0)
    expect(second.sort_order).toBe(1)
    // Creation order, not alphabetical.
    expect((await repo.list()).map((g) => g.name)).toEqual(['Zeta', 'Alpha'])
  })

  it('list() leaves out deleted groupings and breaks equal positions by name', async () => {
    const b = await createNamed('B')
    const a = await createNamed('A')
    const gone = await createNamed('Gone')
    await repo.softDelete(gone.id)
    await db.run('UPDATE account_groupings SET sort_order = 0 WHERE id IN (?, ?)', [a.id, b.id])
    expect((await repo.list()).map((g) => g.name)).toEqual(['A', 'B'])
  })

  it('updates a grouping, only the given fields, and bumps updated_at_utc', async () => {
    const grouping = await repo.create({
      name: 'Original',
      colour: '#CCCCCC',
      icon: primeIcon('star'),
    })
    await new Promise((r) => setTimeout(r, 5))
    await repo.update(grouping.id, { name: 'Updated' })
    const after = (await repo.findById(grouping.id))!
    expect(after.name).toBe('Updated')
    expect(after.colour).toBe('#CCCCCC')
    expect(after.icon).toEqual(primeIcon('star'))
    expect(after.sort_order).toBe(grouping.sort_order)
    expect(after.updated_at_utc > grouping.updated_at_utc).toBe(true)
  })

  it('reorder() stores the given order, writing only moved groupings', async () => {
    const a = await createNamed('A')
    const b = await createNamed('B')
    const c = await createNamed('C')
    await new Promise((r) => setTimeout(r, 5))
    await repo.reorder([a.id, c.id, b.id])
    const after = await repo.list()
    expect(after.map((g) => g.name)).toEqual(['A', 'C', 'B'])
    const byName = new Map(after.map((g) => [g.name, g]))
    expect(byName.get('A')!.updated_at_utc).toEqual(a.updated_at_utc)
    expect(byName.get('B')!.updated_at_utc > b.updated_at_utc).toBe(true)
  })

  it('softDelete() hides the grouping', async () => {
    const grouping = await createNamed('Temp')
    await repo.softDelete(grouping.id)
    expect(await repo.findById(grouping.id)).toBeNull()
    expect(await repo.list()).toHaveLength(0)
  })

  it('softDelete() moves its accounts to the end of the ungrouped ones, keeping their order', async () => {
    const trip = await createNamed('Trip')
    const other = await createNamed('Other')
    await createAccount('Loose', null)
    const card = await createAccount('Card', trip.id)
    const cash = await createAccount('Cash', trip.id)
    const kept = await createAccount('Kept', other.id)
    await new Promise((r) => setTimeout(r, 5))

    await repo.softDelete(trip.id)

    const after = await accounts.list()
    const ungrouped = after.filter((a) => a.grouping_id === null).map((a) => a.name)
    expect(ungrouped).toEqual(['Loose', 'Card', 'Cash'])
    const movedCard = after.find((a) => a.id === card.id)!
    expect(movedCard.updated_at_utc > card.updated_at_utc).toBe(true)
    expect(after.find((a) => a.id === cash.id)!.grouping_id).toBeNull()
    // Accounts of other groupings are untouched.
    expect(after.find((a) => a.id === kept.id)).toEqual(kept)
  })
})
