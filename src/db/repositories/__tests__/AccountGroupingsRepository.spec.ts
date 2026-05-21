import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { AccountGroupingsRepository } from '../AccountGroupingsRepository'

describe('AccountGroupingsRepository', () => {
  let db: Database
  let repo: AccountGroupingsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    repo = new AccountGroupingsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates and finds an account grouping', async () => {
    const grouping = await repo.create({
      name: 'My Accounts',
      colour: '#FF5733',
      icon: 'wallet',
      accounts_ids: [],
    })
    expect(grouping.id).toBeDefined()
    expect(grouping.name).toBe('My Accounts')
    expect(grouping.colour).toBe('#FF5733')
    expect(grouping.icon).toBe('wallet')
    expect(grouping.accounts_ids).toEqual([])

    const found = await repo.findById(grouping.id)
    expect(found).not.toBeNull()
    expect(found?.name).toBe('My Accounts')
  })

  it('returns null for a missing account grouping', async () => {
    expect(await repo.findById('nonexistent')).toBeNull()
  })

  it('round-trips accounts_ids with 0 entries', async () => {
    const grouping = await repo.create({
      name: 'Empty Grouping',
      colour: '#000000',
      icon: 'star',
      accounts_ids: [],
    })
    const found = await repo.findById(grouping.id)
    expect(found?.accounts_ids).toEqual([])
  })

  it('round-trips accounts_ids with 1 entry', async () => {
    const accountId = 'account-uuid-1'
    const grouping = await repo.create({
      name: 'Single Account',
      colour: '#111111',
      icon: 'bank',
      accounts_ids: [accountId],
    })
    const found = await repo.findById(grouping.id)
    expect(found?.accounts_ids).toEqual([accountId])
  })

  it('round-trips accounts_ids with many entries', async () => {
    const accountIds = ['uuid-1', 'uuid-2', 'uuid-3']
    const grouping = await repo.create({
      name: 'Multi Account',
      colour: '#222222',
      icon: 'grid',
      accounts_ids: accountIds,
    })
    const found = await repo.findById(grouping.id)
    expect(found?.accounts_ids).toEqual(accountIds)
  })

  it('list() returns all non-deleted account groupings', async () => {
    await repo.create({
      name: 'Grouping A',
      colour: '#AAAAAA',
      icon: 'a',
      accounts_ids: [],
    })
    await repo.create({
      name: 'Grouping B',
      colour: '#BBBBBB',
      icon: 'b',
      accounts_ids: [],
    })
    const list = await repo.list()
    expect(list).toHaveLength(2)
    expect(list.map((g) => g.name)).toEqual(['Grouping A', 'Grouping B'])
  })

  it('updates account grouping and bumps updated_at_utc', async () => {
    const grouping = await repo.create({
      name: 'Original',
      colour: '#CCCCCC',
      icon: 'original',
      accounts_ids: [],
    })
    const before = (await repo.findById(grouping.id))!
    await new Promise((r) => setTimeout(r, 5))
    await repo.update(grouping.id, { name: 'Updated', colour: '#DDDDDD' })
    const after = (await repo.findById(grouping.id))!
    expect(after.name).toBe('Updated')
    expect(after.colour).toBe('#DDDDDD')
    expect(after.updated_at_utc > before.updated_at_utc).toBe(true)
  })

  it('update changes only provided fields', async () => {
    const grouping = await repo.create({
      name: 'Test',
      colour: '#EEEEEE',
      icon: 'test',
      accounts_ids: ['id-1', 'id-2'],
    })
    await repo.update(grouping.id, { name: 'Changed' })
    const after = await repo.findById(grouping.id)
    expect(after?.name).toBe('Changed')
    expect(after?.colour).toBe('#EEEEEE')
    expect(after?.icon).toBe('test')
    expect(after?.accounts_ids).toEqual(['id-1', 'id-2'])
  })

  it('updates accounts_ids', async () => {
    const grouping = await repo.create({
      name: 'IDs Test',
      colour: '#FFFFFF',
      icon: 'ids',
      accounts_ids: ['old-id'],
    })
    await repo.update(grouping.id, { accounts_ids: ['new-id-1', 'new-id-2'] })
    const after = await repo.findById(grouping.id)
    expect(after?.accounts_ids).toEqual(['new-id-1', 'new-id-2'])
  })

  it('soft-deletes an account grouping', async () => {
    const grouping = await repo.create({
      name: 'Temp Grouping',
      colour: '#111111',
      icon: 'temp',
      accounts_ids: [],
    })
    await repo.softDelete(grouping.id)
    expect(await repo.findById(grouping.id)).toBeNull()
    const list = await repo.list()
    expect(list).toHaveLength(0)
  })
})
