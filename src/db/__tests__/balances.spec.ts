import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { Database } from '../Database'
import { ALL_MIGRATIONS, runMigrations } from '../migrations'
import { AccountsRepository } from '../repositories/AccountsRepository'
import { moneyAmount, zeroMoney, type MoneyAmount } from '../MoneyAmount'
import { newId } from '../uuid'
import type { ShortId } from '../shortId'
import { recalculateBalances } from '../balances'

describe('recalculateBalances', () => {
  let db: Database
  let accounts: AccountsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    accounts = new AccountsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  function account(name: string, currency = 'EUR') {
    return accounts.create({
      name,
      balance: zeroMoney(currency),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#000000',
      icon: primeIcon('wallet'),
    })
  }

  // Raw inserts keep these tests independent of TransactionsRepository, which
  // itself refreshes balances.
  async function tx(
    from: ShortId | null,
    to: ShortId | null,
    out: MoneyAmount,
    in_: MoneyAmount,
    deleted = false,
  ) {
    const now = '2026-10-25T10:00:00.000Z'
    await db.run(
      `INSERT INTO transactions (id, account_id__from, account_id__to,
         amount_value__from, amount_scale__from, amount_currency__from,
         amount_value__to, amount_scale__to, amount_currency__to,
         transaction_at_local, transaction_at_zone, created_at_utc, updated_at_utc, deleted_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-25T12:00:00.000+02:00', 'Europe/Berlin', ?, ?, ?)`,
      [
        newId(),
        from,
        to,
        out.value,
        out.scale,
        out.currency,
        in_.value,
        in_.scale,
        in_.currency,
        now,
        now,
        deleted ? now : null,
      ],
    )
  }

  const balanceOf = async (id: ShortId) => (await accounts.findById(id))!.balance

  it('sums income, spending and transfers in the account currency', async () => {
    const cash = await account('Cash')
    const bank = await account('Bank')
    await tx(null, cash.id, moneyAmount(10000, 2, 'EUR'), moneyAmount(10000, 2, 'EUR')) // income 100
    await tx(cash.id, null, moneyAmount(2550, 2, 'EUR'), moneyAmount(9000, 2, 'AMD')) // spent 25.50
    await tx(cash.id, bank.id, moneyAmount(1000, 2, 'EUR'), moneyAmount(1000, 2, 'EUR')) // transfer 10
    await recalculateBalances(db)
    expect(await balanceOf(cash.id)).toEqual(moneyAmount(6450, 2, 'EUR'))
    expect(await balanceOf(bank.id)).toEqual(moneyAmount(1000, 2, 'EUR'))
  })

  it('adds amounts of different scales exactly', async () => {
    const btc = await account('Cold wallet', 'BTC')
    await tx(null, btc.id, moneyAmount(1, 8, 'BTC'), moneyAmount(1, 8, 'BTC')) // 0.00000001
    await tx(null, btc.id, moneyAmount(15, 1, 'BTC'), moneyAmount(15, 1, 'BTC')) // 1.5
    await recalculateBalances(db)
    expect(await balanceOf(btc.id)).toEqual(moneyAmount(150000001, 8, 'BTC'))
  })

  it('leaves out deleted transactions and legs in another currency', async () => {
    const cash = await account('Cash')
    await tx(null, cash.id, moneyAmount(500, 2, 'EUR'), moneyAmount(500, 2, 'EUR'))
    await tx(null, cash.id, moneyAmount(700, 2, 'EUR'), moneyAmount(700, 2, 'EUR'), true)
    await tx(null, cash.id, moneyAmount(900, 2, 'USD'), moneyAmount(900, 2, 'USD'))
    await recalculateBalances(db)
    expect(await balanceOf(cash.id)).toEqual(moneyAmount(500, 2, 'EUR'))
  })

  it('puts an account without transactions at zero', async () => {
    const cash = await account('Cash')
    await db.run('UPDATE accounts SET balance_value = 777 WHERE id = ?', [cash.id])
    await recalculateBalances(db)
    expect(await balanceOf(cash.id)).toEqual(moneyAmount(0, 2, 'EUR'))
  })

  it('refreshes only the given accounts, and reports how many changed', async () => {
    const cash = await account('Cash')
    const bank = await account('Bank')
    await tx(null, cash.id, moneyAmount(100, 2, 'EUR'), moneyAmount(100, 2, 'EUR'))
    await tx(null, bank.id, moneyAmount(200, 2, 'EUR'), moneyAmount(200, 2, 'EUR'))
    expect(await recalculateBalances(db, [cash.id])).toBe(1)
    expect((await balanceOf(cash.id)).value).toBe(100)
    expect((await balanceOf(bank.id)).value).toBe(0)
    expect(await recalculateBalances(db)).toBe(1) // only Bank was stale
    expect(await recalculateBalances(db)).toBe(0)
  })

  it('does not touch updated_at_utc: the cache is not an edit', async () => {
    const cash = await account('Cash')
    await tx(null, cash.id, moneyAmount(100, 2, 'EUR'), moneyAmount(100, 2, 'EUR'))
    await recalculateBalances(db)
    expect((await accounts.findById(cash.id))!.updated_at_utc).toEqual(cash.updated_at_utc)
  })
})
