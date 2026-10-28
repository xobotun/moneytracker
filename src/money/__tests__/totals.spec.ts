import { describe, it, expect } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { moneyAmount, type MoneyAmount } from '@/db/MoneyAmount'
import { asUuid } from '@/db/uuid'
import { asShortId } from '@/db/shortId'
import type { Account, AppliedRate } from '@/db/types'
import { RateTable } from '../rates'
import { balanceView, totalView } from '../totals'

let n = 0
function account(balance: MoneyAmount): Account {
  n++
  return {
    id: asShortId(`acc-${n}`),
    name: `Account ${n}`,
    balance,
    is_cash: false,
    tags: [],
    location_id: null,
    colour: '#000000',
    icon: primeIcon('wallet'),
    grouping_id: null,
    sort_order: n,
    archived_at_utc: null,
    created_at_utc: new Date(),
    updated_at_utc: new Date(),
    deleted_at_utc: null,
  }
}

function applied(currency_a: string, currency_b: string, rate: number): AppliedRate {
  return {
    id: asUuid(`${currency_a}-${currency_b}`),
    date: '2026-10-24',
    currency_a,
    currency_b,
    rate,
    provider: 'test',
    via: null,
    reference_date: '2026-10-24',
    created_at_utc: new Date(),
    updated_at_utc: new Date(),
    deleted_at_utc: null,
  }
}

const rates = RateTable.fromApplied([applied('EUR', 'USD', 2), applied('EUR', 'RUB', 100)])

describe('balanceView (one account)', () => {
  it('shows only the native amount in the base currency', () => {
    expect(balanceView(account(moneyAmount(1250, 2, 'EUR')), 'EUR', rates)).toEqual({
      native: moneyAmount(1250, 2, 'EUR'),
      base: null,
      relation: '≈',
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
      relation: '≈',
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
    expect(view).toEqual({
      native: moneyAmount(175, 2, 'EUR'),
      base: null,
      relation: '≈',
      missingRates: [],
    })
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

  describe('mixed currencies with a missing rate', () => {
    const eur = (cents: number) => account(moneyAmount(cents, 2, 'EUR'))
    const btc = (sats: number) => account(moneyAmount(sats, 8, 'BTC'))
    const aed = (fils: number) => account(moneyAmount(fils, 2, 'AED'))

    it('gives a lower bound (≥) when the left-out balances are positive', () => {
      const view = totalView([eur(1000), btc(1), aed(500)], 'EUR', rates)!
      expect(view.native).toBeNull()
      expect(view.base).toEqual({ value: 10, currency: 'EUR' })
      expect(view.relation).toBe('≥')
      expect(view.missingRates).toEqual(['BTC', 'AED'])
    })

    it('gives an upper bound (≤) when the left-out balances are negative', () => {
      const view = totalView([eur(1000), aed(-500)], 'EUR', rates)!
      expect(view.base).toEqual({ value: 10, currency: 'EUR' })
      expect(view.relation).toBe('≤')
    })

    it('gives no amount when the left-out balances have both signs', () => {
      const view = totalView([eur(1000), aed(-500), btc(1)], 'EUR', rates)!
      expect(view.base).toBeNull()
      expect(view.missingRates).toEqual(['AED', 'BTC'])
    })

    it('stays ≈ when every left-out balance is zero', () => {
      const view = totalView([eur(1000), aed(0)], 'EUR', rates)!
      expect(view.base).toEqual({ value: 10, currency: 'EUR' })
      expect(view.relation).toBe('≈')
      expect(view.missingRates).toEqual(['AED'])
    })
  })
})
