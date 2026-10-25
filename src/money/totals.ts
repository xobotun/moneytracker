import { moneyToNumber, sumMoney, type MoneyAmount } from '@/db/MoneyAmount'
import type { Account } from '@/db/types'
import type { RateTable } from './rates'

/** An approximate amount, converted at an exchange rate: for display only. */
export interface Converted {
  value: number
  currency: string
}

/**
 * How a base-currency amount relates to the true total: equal but for the
 * rates (≈), or a bound when some balances could not be converted and were
 * left out — all of them ≥ 0 make the rest a lower bound (≥), all ≤ 0 an
 * upper one (≤).
 */
export type Relation = '≈' | '≥' | '≤'

/** What to show for a balance: the native amount and/or the base-currency one. */
export interface BalanceView {
  /** The exact amount in its own currency; null for a total over mixed currencies. */
  native: MoneyAmount | null
  /** In the base currency; null when `native` already is in it, or nothing can be said. */
  base: Converted | null
  relation: Relation
  /** Currencies that could not be converted to the base one. */
  missingRates: string[]
}

function inBase(amount: MoneyAmount, baseCurrency: string, rates: RateTable): BalanceView {
  const view = { native: amount, base: null, relation: '≈' as const, missingRates: [] }
  if (amount.currency === baseCurrency) return view
  const value = rates.convert(moneyToNumber(amount), amount.currency, baseCurrency)
  return value === null
    ? { ...view, missingRates: [amount.currency] }
    : { ...view, base: { value, currency: baseCurrency } }
}

/** An account: its balance, plus ≈ the base currency when it is in another. */
export function balanceView(account: Account, baseCurrency: string, rates: RateTable): BalanceView {
  return inBase(account.balance, baseCurrency, rates)
}

/**
 * Accounts together (a group, or the whole page). All in one currency: their
 * exact sum, plus ≈ the base currency when it is another. Mixed currencies:
 * only the base currency — ≈ the total, or, when some currencies have no
 * rate, the rest as a bound (≥ / ≤, see Relation) naming those currencies;
 * no amount at all when the left-out balances have both signs. No accounts:
 * null.
 */
export function totalView(
  accounts: readonly Account[],
  baseCurrency: string,
  rates: RateTable,
): BalanceView | null {
  if (accounts.length === 0) return null
  const currencies = [...new Set(accounts.map((a) => a.balance.currency))]
  if (currencies.length === 1) {
    return inBase(
      sumMoney(
        accounts.map((a) => a.balance),
        currencies[0]!,
      ),
      baseCurrency,
      rates,
    )
  }
  let total = 0
  const missing = new Set<string>()
  let leftOutPositive = false
  let leftOutNegative = false
  for (const a of accounts) {
    const value = rates.convert(moneyToNumber(a.balance), a.balance.currency, baseCurrency)
    if (value !== null) {
      total += value
      continue
    }
    missing.add(a.balance.currency)
    if (a.balance.value > 0) leftOutPositive = true
    if (a.balance.value < 0) leftOutNegative = true
  }
  const missingRates = [...missing]
  if (leftOutPositive && leftOutNegative) {
    return { native: null, base: null, relation: '≈', missingRates }
  }
  const relation: Relation = leftOutPositive ? '≥' : leftOutNegative ? '≤' : '≈'
  return { native: null, base: { value: total, currency: baseCurrency }, relation, missingRates }
}
