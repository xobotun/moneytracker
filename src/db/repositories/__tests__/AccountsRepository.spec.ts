import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { AccountsRepository } from '../AccountsRepository'
import { moneyAmount } from '../../MoneyAmount'

describe('AccountsRepository', () => {
  let db: Database
  let repo: AccountsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    repo = new AccountsRepository(db)
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
    expect(await repo.findById('nonexistent')).toBeNull()
  })

  it('round-trips balance MoneyAmount with scale=2', async () => {
    const account = await repo.create({
      name: 'USD Account',
      balance: moneyAmount(1234, 2, 'USD'),
      tags: [],
      location_id: null,
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
      colour: '#0FF',
      icon: 'wallet',
    })
    const found = await repo.findById(account.id)
    expect(found?.tags).toEqual(['savings', 'emergency'])
  })

  it('list() returns all non-deleted accounts', async () => {
    await repo.create({
      name: 'Account A',
      balance: moneyAmount(1000, 2, 'USD'),
      tags: [],
      location_id: null,
      colour: '#000',
      icon: 'x',
    })
    await repo.create({
      name: 'Account B',
      balance: moneyAmount(2000, 2, 'USD'),
      tags: [],
      location_id: null,
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
      colour: '#000',
      icon: 'x',
    })
    await repo.softDelete(account.id)
    expect(await repo.findById(account.id)).toBeNull()
    const list = await repo.list()
    expect(list).toHaveLength(0)
  })

  it('throws when creating with non-existent location_id (FK violation)', async () => {
    await expect(
      repo.create({
        name: 'Bad Location',
        balance: moneyAmount(1000, 2, 'USD'),
        tags: [],
        location_id: 'nonexistent-location-id',
        colour: '#000',
        icon: 'bank',
      }),
    ).rejects.toThrow()
  })
})
