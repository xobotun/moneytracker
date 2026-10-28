import { describe, it, expect } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { moneyAmount } from '@/db/MoneyAmount'
import { asShortId } from '@/db/shortId'
import type { Account, AccountGrouping } from '@/db/types'
import type { AccountSection } from '@/stores/accounts'
import { byCurrency } from '../byCurrency'

function account(name: string, value: number, currency: string, is_cash = false): Account {
  return {
    id: asShortId(`acc-${name}`),
    name,
    balance: moneyAmount(value, 2, currency),
    is_cash,
    tags: [],
    location_id: null,
    colour: '#000000',
    icon: primeIcon('wallet'),
    grouping_id: null,
    sort_order: 0,
    archived_at_utc: null,
    created_at_utc: new Date(),
    updated_at_utc: new Date(),
    deleted_at_utc: null,
  }
}

function grouping(name: string): AccountGrouping {
  return {
    id: asShortId(`grp-${name}`),
    name,
    colour: '#000000',
    icon: primeIcon('folder'),
    sort_order: 0,
    created_at_utc: new Date(),
    updated_at_utc: new Date(),
    deleted_at_utc: null,
  }
}

const names = (rows: { account: Account }[]) => rows.map((r) => r.account.name)

describe('byCurrency', () => {
  it('puts the base currency first, then the others by code', () => {
    const sections: AccountSection[] = [
      {
        grouping: null,
        accounts: [
          account('Rubles', 100, 'RUB'),
          account('Dollars', 100, 'USD'),
          account('Euros', 100, 'EUR'),
          account('Dirhams', 100, 'AED'),
        ],
      },
    ]
    expect(byCurrency(sections, 'EUR').map((b) => b.currency)).toEqual(['EUR', 'AED', 'RUB', 'USD'])
    expect(byCurrency(sections, 'USD').map((b) => b.currency)).toEqual(['USD', 'AED', 'EUR', 'RUB'])
  })

  it('has no block for a base currency that no account uses', () => {
    const sections = [{ grouping: null, accounts: [account('Dollars', 100, 'USD')] }]
    expect(byCurrency(sections, 'EUR').map((b) => b.currency)).toEqual(['USD'])
  })

  it('splits each currency into cash then bank, keeping the page order and each group', () => {
    const home = grouping('Home')
    const trip = grouping('Trip')
    const sections: AccountSection[] = [
      {
        grouping: home,
        accounts: [
          account('Main card', 1000, 'EUR'),
          account('Wallet', 250, 'EUR', true),
          account('Savings', 5000, 'EUR'),
        ],
      },
      {
        grouping: trip,
        accounts: [account('Travel cash', 4000, 'USD', true), account('Coins', 50, 'EUR', true)],
      },
      { grouping: null, accounts: [account('Old card', -300, 'EUR')] },
    ]
    const [eur, usd] = byCurrency(sections, 'EUR')

    expect(eur!.kinds.map((k) => k.kind)).toEqual(['cash', 'bank'])
    const [cash, bank] = eur!.kinds
    expect(names(cash!.rows)).toEqual(['Wallet', 'Coins'])
    expect(cash!.rows.map((r) => r.grouping?.name)).toEqual(['Home', 'Trip'])
    expect(cash!.total).toEqual(moneyAmount(300, 2, 'EUR'))
    expect(names(bank!.rows)).toEqual(['Main card', 'Savings', 'Old card'])
    expect(bank!.rows.map((r) => r.grouping?.name ?? null)).toEqual(['Home', 'Home', null])
    expect(bank!.total).toEqual(moneyAmount(5700, 2, 'EUR'))
    expect(eur!.accounts.map((a) => a.name)).toEqual([
      'Main card',
      'Wallet',
      'Savings',
      'Coins',
      'Old card',
    ])

    // A currency with cash only has no bank part.
    expect(usd!.kinds.map((k) => k.kind)).toEqual(['cash'])
    expect(usd!.kinds[0]!.total).toEqual(moneyAmount(4000, 2, 'USD'))
  })

  it('sums exactly across scales', () => {
    const btc = { ...account('Cold', 0, 'BTC'), balance: moneyAmount(150000000, 8, 'BTC') }
    const hot = { ...account('Hot', 0, 'BTC'), balance: moneyAmount(25, 2, 'BTC') }
    const [block] = byCurrency([{ grouping: null, accounts: [btc, hot] }], 'EUR')
    expect(block!.kinds[0]!.total).toEqual(moneyAmount(175000000, 8, 'BTC'))
  })

  it('is empty when there are no accounts', () => {
    expect(byCurrency([{ grouping: grouping('Home'), accounts: [] }], 'EUR')).toEqual([])
  })
})
