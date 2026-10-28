import { sumMoney, type MoneyAmount } from '@/db/MoneyAmount'
import type { Account, AccountGrouping } from '@/db/types'
import type { AccountSection } from '@/stores/accounts'

/** An account with the group it sits in on the usual page (null: none). */
export interface PlacedAccount {
  account: Account
  grouping: AccountGrouping | null
}

/** Cash (money in hand) or bank (everything else), by `accounts.is_cash`. */
export type MoneyKind = 'cash' | 'bank'

/** The accounts of one kind within one currency, with their exact sum. */
export interface KindGroup {
  kind: MoneyKind
  rows: PlacedAccount[]
  total: MoneyAmount
}

/** One currency's accounts: its cash and its bank accounts, each kind only when it has some. */
export interface CurrencyBlock {
  currency: string
  kinds: KindGroup[]
  /** Every account of the block, for its total. */
  accounts: Account[]
}

/**
 * The accounts of `sections` (the store's, active accounts only) regrouped
 * by currency: the base currency's block first, then the others by code.
 * Inside a block, cash accounts come before bank ones, and each keeps the
 * order of the usual page. Empty kinds are left out.
 */
export function byCurrency(
  sections: readonly AccountSection[],
  baseCurrency: string,
): CurrencyBlock[] {
  const byCode = new Map<string, PlacedAccount[]>()
  for (const { grouping, accounts } of sections) {
    for (const account of accounts) {
      const code = account.balance.currency
      const rows = byCode.get(code) ?? []
      rows.push({ account, grouping })
      byCode.set(code, rows)
    }
  }
  const codes = [...byCode.keys()].sort((a, b) =>
    a === baseCurrency ? -1 : b === baseCurrency ? 1 : a < b ? -1 : a > b ? 1 : 0,
  )
  return codes.map((currency) => {
    const rows = byCode.get(currency)!
    const kinds = (['cash', 'bank'] as const).flatMap((kind): KindGroup[] => {
      const ofKind = rows.filter((r) => r.account.is_cash === (kind === 'cash'))
      if (ofKind.length === 0) return []
      const total = sumMoney(
        ofKind.map((r) => r.account.balance),
        currency,
      )
      return [{ kind, rows: ofKind, total }]
    })
    return { currency, kinds, accounts: rows.map((r) => r.account) }
  })
}
