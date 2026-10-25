import { moneyToNumber, sumMoney, type MoneyAmount } from '@/db/MoneyAmount'
import type { Account } from '@/db/types'
import type { RateTable } from './rates'

/** An approximate amount, converted at an exchange rate: for display only. */
export interface Converted {
  value: number
  currency: string
}

/** What to show for a balance: the native amount and/or the base-currency one. */
export interface BalanceView {
  /** The exact amount in its own currency; null for a total over mixed currencies. */
  native: MoneyAmount | null
  /** ≈ in the base currency; null when `native` already is in it, or a rate is missing. */
  base: Converted | null
  /** Currencies that could not be converted to the base one (then `base` is null). */
  missingRates: string[]
}

function inBase(amount: MoneyAmount, baseCurrency: string, rates: RateTable): BalanceView {
  if (amount.currency === baseCurrency) return { native: amount, base: null, missingRates: [] }
  const value = rates.convert(moneyToNumber(amount), amount.currency, baseCurrency)
  return value === null
    ? { native: amount, base: null, missingRates: [amount.currency] }
    : { native: amount, base: { value, currency: baseCurrency }, missingRates: [] }
}

/** An account: its balance, plus ≈ the base currency when it is in another. */
export function balanceView(account: Account, baseCurrency: string, rates: RateTable): BalanceView {
  return inBase(account.balance, baseCurrency, rates)
}

/**
 * Accounts together (a group, or the whole page). All in one currency: their
 * exact sum, plus ≈ the base currency when it is another. Mixed currencies:
 * only ≈ the base currency — or nothing, naming the currencies without a
 * rate. No accounts: null.
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
  for (const a of accounts) {
    const value = rates.convert(moneyToNumber(a.balance), a.balance.currency, baseCurrency)
    if (value === null) missing.add(a.balance.currency)
    else total += value
  }
  return missing.size > 0
    ? { native: null, base: null, missingRates: [...missing] }
    : { native: null, base: { value: total, currency: baseCurrency }, missingRates: [] }
}
