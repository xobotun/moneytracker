import type { SqlExecutor } from './Database'
import type { UUID } from './uuid'

// accounts.balance_value / balance_scale cache each account's balance, so the
// accounts page need not sum every transaction to show it. The transactions
// are the truth: the cache is for display and for adding up totals, never for
// deciding anything about money. It is rebuilt from the transactions here —
// on every transaction write, after every sync merge, and on demand.

/**
 * Rebuilds the cached balance of `accountIds` (all accounts when omitted)
 * from their live transactions: what arrived minus what left, in the
 * account's own currency (legs in another currency are not its money and are
 * left out). Exact: amounts of different scales are brought to the largest.
 *
 * Writes only balances that changed, and never touches `updated_at_utc` — a
 * refreshed cache is not an edit, and must not win a sync merge against one.
 * Returns how many balances changed.
 */
export async function recalculateBalances(
  db: SqlExecutor,
  accountIds?: readonly UUID[],
): Promise<number> {
  const only = accountIds ? `WHERE a.id IN (${accountIds.map(() => '?').join(', ')})` : ''
  if (accountIds?.length === 0) return 0

  const accounts = await db.exec<{ id: string; balance_value: number; balance_scale: number }>(
    `SELECT a.id, a.balance_value, a.balance_scale FROM accounts a ${only}`,
    accountIds ? [...accountIds] : [],
  )
  const sums = await db.exec<{ account_id: string; scale: number; value: number }>(
    `SELECT a.id AS account_id, l.scale AS scale, SUM(l.value) AS value
     FROM accounts a
     JOIN (
       SELECT account_id__to AS account_id, amount_currency__to AS currency,
              amount_scale__to AS scale, amount_value__to AS value
       FROM transactions WHERE deleted_at_utc IS NULL AND account_id__to IS NOT NULL
       UNION ALL
       SELECT account_id__from, amount_currency__from,
              amount_scale__from, -amount_value__from
       FROM transactions WHERE deleted_at_utc IS NULL AND account_id__from IS NOT NULL
     ) l ON l.account_id = a.id AND l.currency = a.currency
     ${only}
     GROUP BY a.id, l.scale`,
    accountIds ? [...accountIds] : [],
  )

  const byAccount = new Map<string, { scale: number; value: number }[]>()
  for (const s of sums) {
    byAccount.set(s.account_id, [...(byAccount.get(s.account_id) ?? []), s])
  }

  let changed = 0
  for (const account of accounts) {
    const parts = byAccount.get(account.id) ?? []
    // No transactions: zero, at the scale the cache already has.
    const scale =
      parts.length === 0 ? account.balance_scale : Math.max(...parts.map((p) => p.scale))
    const total = parts.reduce(
      (sum, p) => sum + BigInt(p.value) * 10n ** BigInt(scale - p.scale),
      0n,
    )
    if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`Balance of account ${account.id} is beyond the safe-integer range`)
    }
    const value = Number(total)
    if (value === account.balance_value && scale === account.balance_scale) continue
    await db.run('UPDATE accounts SET balance_value = ?, balance_scale = ? WHERE id = ?', [
      value,
      scale,
      account.id,
    ])
    changed++
  }
  return changed
}
