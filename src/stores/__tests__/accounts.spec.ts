import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { AccountsRepository } from '@/db/repositories/AccountsRepository'
import { TransactionsRepository } from '@/db/repositories/TransactionsRepository'
import { moneyAmount, zeroMoney } from '@/db/MoneyAmount'
import { localMoment } from '@/db/LocalMoment'
import { useAccountsStore } from '../accounts'

// Real repositories over an in-memory database, so the store is tested
// against the real write-through behaviour rather than a hand-written fake.
let accountsRepo: AccountsRepository
let transactionsRepo: TransactionsRepository
vi.mock('@/db/init', () => ({
  getAccountsRepository: () => accountsRepo,
  getTransactionsRepository: () => transactionsRepo,
}))

function input(name: string) {
  return {
    name,
    balance: zeroMoney('EUR'),
    tags: [],
    location_id: null,
    colour: '#3b82f6',
    icon: 'wallet',
  }
}

describe('useAccountsStore', () => {
  let db: Database

  beforeEach(async () => {
    setActivePinia(createPinia())
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    accountsRepo = new AccountsRepository(db)
    transactionsRepo = new TransactionsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  const names = () => useAccountsStore().accounts.map((a) => a.name)

  it('load() reads the accounts in list order', async () => {
    await accountsRepo.create(input('Cash'))
    await accountsRepo.create(input('Bank'))
    const store = useAccountsStore()
    expect(store.loaded).toBe(false)
    await store.load()
    expect(store.loaded).toBe(true)
    expect(names()).toEqual(['Cash', 'Bank'])
  })

  it('create() persists and appends', async () => {
    const store = useAccountsStore()
    await store.create(input('Cash'))
    await store.create(input('Bank'))
    expect(names()).toEqual(['Cash', 'Bank'])
    expect((await accountsRepo.list()).map((a) => a.name)).toEqual(['Cash', 'Bank'])
  })

  it('update() persists the patch', async () => {
    const store = useAccountsStore()
    const cash = await store.create(input('Cash'))
    await store.update(cash.id, { name: 'Pocket', colour: '#ef4444' })
    expect(store.accounts[0]).toMatchObject({ name: 'Pocket', colour: '#ef4444' })
    expect((await accountsRepo.findById(cash.id))!.name).toBe('Pocket')
  })

  it('move() reorders and persists', async () => {
    const store = useAccountsStore()
    await store.create(input('A'))
    await store.create(input('B'))
    const c = await store.create(input('C'))
    await store.move(c.id, 0)
    expect(names()).toEqual(['C', 'A', 'B'])
    await store.move(c.id, 2)
    expect(names()).toEqual(['A', 'B', 'C'])
    expect((await accountsRepo.list()).map((a) => a.name)).toEqual(['A', 'B', 'C'])
  })

  it('move() clamps the target index into the list', async () => {
    const store = useAccountsStore()
    const a = await store.create(input('A'))
    await store.create(input('B'))
    await store.move(a.id, 99)
    expect(names()).toEqual(['B', 'A'])
    await store.move(a.id, -5)
    expect(names()).toEqual(['A', 'B'])
  })

  it('remove() soft-deletes the account', async () => {
    const store = useAccountsStore()
    const cash = await store.create(input('Cash'))
    await store.create(input('Bank'))
    await store.remove(cash.id)
    expect(names()).toEqual(['Bank'])
    expect(await accountsRepo.findById(cash.id)).toBeNull()
  })

  it('remove() refuses an account that live transactions still use', async () => {
    const store = useAccountsStore()
    const cash = await store.create(input('Cash'))
    await transactionsRepo.create({
      account_id__from: cash.id,
      account_id__to: null,
      amount__from: moneyAmount(500, 2, 'EUR'),
      amount__to: moneyAmount(500, 2, 'EUR'),
      transaction_at: localMoment('2026-10-01T12:00:00.000+02:00', 'Europe/Berlin'),
      date_override: null,
      tags: [],
      location_lat: null,
      location_lon: null,
      location_id: null,
    })
    await expect(store.remove(cash.id)).rejects.toThrow(/1 transaction/)
    expect(names()).toEqual(['Cash'])
    expect(await accountsRepo.findById(cash.id)).not.toBeNull()
  })

  it('a failed write leaves the state as it was and rethrows', async () => {
    const store = useAccountsStore()
    const cash = await store.create(input('Cash'))
    vi.spyOn(accountsRepo, 'update').mockRejectedValueOnce(new Error('disk full'))
    await expect(store.update(cash.id, { name: 'Pocket' })).rejects.toThrow('disk full')
    expect(names()).toEqual(['Cash'])
  })
})
