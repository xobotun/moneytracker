import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { AccountsRepository } from '@/db/repositories/AccountsRepository'
import { AccountGroupingsRepository } from '@/db/repositories/AccountGroupingsRepository'
import { TransactionsRepository } from '@/db/repositories/TransactionsRepository'
import { moneyAmount, zeroMoney } from '@/db/MoneyAmount'
import { localMoment } from '@/db/LocalMoment'
import type { UUID } from '@/db/uuid'
import { useAccountsStore } from '../accounts'

// Real repositories over an in-memory database, so the store is tested
// against the real write-through behaviour rather than a hand-written fake.
let accountsRepo: AccountsRepository
let groupingsRepo: AccountGroupingsRepository
let transactionsRepo: TransactionsRepository
vi.mock('@/db/init', () => ({
  getAccountsRepository: () => accountsRepo,
  getAccountGroupingsRepository: () => groupingsRepo,
  getTransactionsRepository: () => transactionsRepo,
}))

function input(name: string) {
  return {
    name,
    balance: zeroMoney('EUR'),
    tags: [],
    location_id: null,
    grouping_id: null,
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
    groupingsRepo = new AccountGroupingsRepository(db)
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

  describe('groups and order', () => {
    // Names per section, groups first (by name) and the ungrouped ones as '-'.
    const layout = () =>
      Object.fromEntries(
        useAccountsStore().sections.map((s) => [
          s.grouping?.name ?? '-',
          s.accounts.map((a) => a.name),
        ]),
      )

    async function setUp() {
      const store = useAccountsStore()
      const trip = await store.createGrouping({ name: 'Trip', colour: '#000000', icon: 'car' })
      const home = await store.createGrouping({ name: 'Home', colour: '#000000', icon: 'home' })
      const a = await store.create({ ...input('A'), grouping_id: trip.id })
      const b = await store.create({ ...input('B'), grouping_id: trip.id })
      const c = await store.create({ ...input('C'), grouping_id: home.id })
      const d = await store.create(input('D'))
      return { store, trip, home, a, b, c, d }
    }

    it('lists each group with its accounts, then the ungrouped accounts', async () => {
      await setUp()
      const store = useAccountsStore()
      expect(store.sections.map((s) => s.grouping?.name ?? null)).toEqual(['Trip', 'Home', null])
      expect(layout()).toEqual({ Trip: ['A', 'B'], Home: ['C'], '-': ['D'] })
    })

    it('always ends with the ungrouped section, even when it is empty', async () => {
      const store = useAccountsStore()
      await store.createGrouping({ name: 'Trip', colour: '#000000', icon: 'car' })
      expect(store.sections.map((s) => s.grouping?.name ?? null)).toEqual(['Trip', null])
      expect(store.sections[1]!.accounts).toEqual([])
    })

    it('shows an account whose group was deleted elsewhere with the ungrouped ones', async () => {
      const { trip } = await setUp()
      // As a sync merge can leave it: the group row deleted, its accounts not moved.
      await db.run('UPDATE account_groupings SET deleted_at_utc = ? WHERE id = ?', [
        '2026-10-25T00:00:00.000Z',
        trip.id,
      ])
      await useAccountsStore().load()
      // Their old positions mix with the ungrouped ones; the next move renumbers.
      expect(Object.keys(layout())).toEqual(['Home', '-'])
      expect(layout()['-']!.sort()).toEqual(['A', 'B', 'D'])
    })

    it('moveAccount() places an account in a group at the given index', async () => {
      const { store, home, d } = await setUp()
      await store.moveAccount(d.id, home.id, 0)
      expect(layout()).toEqual({ Trip: ['A', 'B'], Home: ['D', 'C'], '-': [] })
      await store.moveAccount(d.id, home.id, 99) // clamped
      expect(layout()).toEqual({ Trip: ['A', 'B'], Home: ['C', 'D'], '-': [] })
      await store.load()
      expect(layout()).toEqual({ Trip: ['A', 'B'], Home: ['C', 'D'], '-': [] })
    })

    it('moveAccountBy() steps within a group and across group boundaries', async () => {
      const { store, a, b, c } = await setUp()
      await store.moveAccountBy(a.id, 1)
      expect(layout()).toEqual({ Trip: ['B', 'A'], Home: ['C'], '-': ['D'] })
      await store.moveAccountBy(a.id, 1) // last of Trip → first of Home
      expect(layout()).toEqual({ Trip: ['B'], Home: ['A', 'C'], '-': ['D'] })
      await store.moveAccountBy(c.id, 1) // last of Home → first of the ungrouped
      expect(layout()).toEqual({ Trip: ['B'], Home: ['A'], '-': ['C', 'D'] })
      await store.moveAccountBy(c.id, -1) // first of the ungrouped → last of Home
      expect(layout()).toEqual({ Trip: ['B'], Home: ['A', 'C'], '-': ['D'] })
      await store.moveAccountBy(b.id, -1) // first of all: stays
      expect(layout()).toEqual({ Trip: ['B'], Home: ['A', 'C'], '-': ['D'] })
    })

    it('moveAccountBy() passes into an empty group', async () => {
      const store = useAccountsStore()
      await store.createGrouping({ name: 'Empty', colour: '#000000', icon: 'car' })
      const a = await store.create(input('A'))
      await store.moveAccountBy(a.id, -1)
      expect(layout()).toEqual({ Empty: ['A'], '-': [] })
    })

    it('canMoveAccountBy() is false only at the very start and end', async () => {
      const { store, a, b, d } = await setUp()
      expect(store.canMoveAccountBy(a.id, -1)).toBe(false)
      expect(store.canMoveAccountBy(a.id, 1)).toBe(true)
      expect(store.canMoveAccountBy(b.id, 1)).toBe(true)
      expect(store.canMoveAccountBy(d.id, 1)).toBe(false)
      expect(store.canMoveAccountBy(d.id, -1)).toBe(true)
    })

    it('moveGrouping() reorders the groups', async () => {
      const { store, home } = await setUp()
      await store.moveGrouping(home.id, 0)
      expect(store.sections.map((s) => s.grouping?.name ?? null)).toEqual(['Home', 'Trip', null])
    })

    it('updateGrouping() persists the patch', async () => {
      const { store, trip } = await setUp()
      await store.updateGrouping(trip.id, { name: 'Holiday' })
      expect(store.groupings.map((g) => g.name)).toEqual(['Holiday', 'Home'])
    })

    it('removeGrouping() deletes the group and keeps its accounts below the groups', async () => {
      const { store, trip } = await setUp()
      await store.removeGrouping(trip.id)
      expect(layout()).toEqual({ Home: ['C'], '-': ['D', 'A', 'B'] })
    })
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

  describe('balances', () => {
    const income = (to: UUID, cents: number) =>
      transactionsRepo.create({
        account_id__from: null,
        account_id__to: to,
        amount__from: moneyAmount(cents, 2, 'EUR'),
        amount__to: moneyAmount(cents, 2, 'EUR'),
        transaction_at: localMoment('2026-10-01T12:00:00.000+02:00', 'Europe/Berlin'),
        date_override: null,
        tags: [],
        location_lat: null,
        location_lon: null,
        location_id: null,
      })

    it('shows the cached balance kept by transaction writes', async () => {
      const store = useAccountsStore()
      const cash = await store.create(input('Cash'))
      await income(cash.id, 1250)
      await store.load()
      expect(store.accounts[0]!.balance).toEqual(moneyAmount(1250, 2, 'EUR'))
    })

    it('recalculateBalances() repairs a stale cache and reports it', async () => {
      const store = useAccountsStore()
      const cash = await store.create(input('Cash'))
      await income(cash.id, 1250)
      await db.run('UPDATE accounts SET balance_value = 1 WHERE id = ?', [cash.id])
      expect(await store.recalculateBalances()).toBe(1)
      expect(store.accounts[0]!.balance.value).toBe(1250)
      expect(await store.recalculateBalance(cash.id)).toBe(false) // already right
    })

    it('refuses a currency change while transactions use the account', async () => {
      const store = useAccountsStore()
      const cash = await store.create(input('Cash'))
      await income(cash.id, 1250)
      await expect(store.update(cash.id, { balance: moneyAmount(1250, 2, 'USD') })).rejects.toThrow(
        /currency cannot change: 1 transaction uses it in EUR/,
      )
      expect((await accountsRepo.findById(cash.id))!.balance.currency).toBe('EUR')
    })

    it('allows a currency change on an account without transactions', async () => {
      const store = useAccountsStore()
      const cash = await store.create(input('Cash'))
      await store.update(cash.id, { balance: moneyAmount(0, 2, 'USD') })
      expect(store.accounts[0]!.balance.currency).toBe('USD')
    })
  })

  it('a failed write leaves the state as it was and rethrows', async () => {
    const store = useAccountsStore()
    const cash = await store.create(input('Cash'))
    vi.spyOn(accountsRepo, 'update').mockRejectedValueOnce(new Error('disk full'))
    await expect(store.update(cash.id, { name: 'Pocket' })).rejects.toThrow('disk full')
    expect(names()).toEqual(['Cash'])
  })
})
