import { describe, it, expect } from 'vitest'
import { moneyAmount, type MoneyAmount } from '@/db/MoneyAmount'
import { asUuid } from '@/db/uuid'
import type { Account, ExchangeRate } from '@/db/types'
import { RateTable } from '../rates'
import { balanceView, totalView } from '../totals'

let n = 0
function account(balance: MoneyAmount): Account {
  n++
  return {
    id: asUuid(`acc-${n}`),
    name: `Account ${n}`,
    balance,
    tags: [],
    location_id: null,
    colour: '#000000',
    icon: 'wallet',
    grouping_id: null,
    sort_order: n,
    created_at_utc: new Date(),
    updated_at_utc: new Date(),
    deleted_at_utc: null,
  }
}

const rates = RateTable.fromRows([
  {
    id: asUuid('r'),
    date: '2026-10-24',
    base_currency: 'EUR',
    rates: { USD: 2, RUB: 100 },
    provider: 'test',
    created_at_utc: new Date(),
    updated_at_utc: new Date(),
    deleted_at_utc: null,
  } satisfies ExchangeRate,
])

describe('balanceView (one account)', () => {
  it('shows only the native amount in the base currency', () => {
    expect(balanceView(account(moneyAmount(1250, 2, 'EUR')), 'EUR', rates)).toEqual({
      native: moneyAmount(1250, 2, 'EUR'),
      base: null,
      missingRates: [],
    })
  })

  it('adds the converted amount for another currency', () => {
    const view = balanceView(account(moneyAmount(1000, 2, 'USD')), 'EUR', rates)
    expect(view.native).toEqual(moneyAmount(1000, 2, 'USD'))
    expect(view.base!.currency).toBe('EUR')
    expect(view.base!.value).toBeCloseTo(5)
    expect(view.missingRates).toEqual([])
  })

  it('names the currency when there is no rate', () => {
    expect(balanceView(account(moneyAmount(1, 8, 'BTC')), 'EUR', rates)).toEqual({
      native: moneyAmount(1, 8, 'BTC'),
      base: null,
      missingRates: ['BTC'],
    })
  })
})

describe('totalView (a group, or the whole page)', () => {
  it('is nothing for no accounts', () => {
    expect(totalView([], 'EUR', rates)).toBeNull()
  })

  it('sums one currency exactly, natively', () => {
    const view = totalView(
      [account(moneyAmount(15, 1, 'EUR')), account(moneyAmount(25, 2, 'EUR'))],
      'EUR',
      rates,
    )!
    expect(view).toEqual({ native: moneyAmount(175, 2, 'EUR'), base: null, missingRates: [] })
  })

  it('adds the base amount when the one currency is another', () => {
    const view = totalView(
      [account(moneyAmount(300, 2, 'USD')), account(moneyAmount(100, 2, 'USD'))],
      'EUR',
      rates,
    )!
    expect(view.native).toEqual(moneyAmount(400, 2, 'USD'))
    expect(view.base!.value).toBeCloseTo(2)
  })

  it('shows only the base amount for mixed currencies', () => {
    const view = totalView(
      [account(moneyAmount(1000, 2, 'EUR')), account(moneyAmount(1000, 2, 'USD'))],
      'EUR',
      rates,
    )!
    expect(view.native).toBeNull()
    expect(view.base!.currency).toBe('EUR')
    expect(view.base!.value).toBeCloseTo(15)
  })

  it('has no base amount when a currency lacks a rate, and names it', () => {
    const view = totalView(
      [
        account(moneyAmount(1000, 2, 'EUR')),
        account(moneyAmount(1, 8, 'BTC')),
        account(moneyAmount(2, 8, 'BTC')),
      ],
      'EUR',
      rates,
    )!
    expect(view).toEqual({ native: null, base: null, missingRates: ['BTC'] })
  })
})
