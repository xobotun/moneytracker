/**
 * A BigDecimal-style monetary amount.
 *
 * `value` is the unscaled integer (e.g., 1234), `scale` is the number of decimal
 * places (e.g., 2 → 12.34), `currency` is an opaque code (ISO 4217 like 'USD' or
 * custom like 'BTC'). Mirrors Java's `BigDecimal(unscaledValue, scale)` + a tag.
 */
export interface MoneyAmount {
  readonly value: number
  readonly scale: number
  readonly currency: string
}

export function moneyAmount(value: number, scale: number, currency: string): MoneyAmount {
  // isSafeInteger, not isInteger: beyond ±2^53 a JS number can no longer hold
  // every integer exactly (Number.isInteger(2 ** 60) is still true), so the
  // amount would already be silently rounded. Fail loudly instead.
  if (!Number.isSafeInteger(value)) {
    throw new Error(`MoneyAmount value must be a safe integer (|value| ≤ 2^53 − 1), got ${value}`)
  }
  if (!Number.isInteger(scale) || scale < 0)
    throw new Error(`MoneyAmount scale must be a non-negative integer, got ${scale}`)
  if (!currency || currency.trim().length === 0)
    throw new Error('MoneyAmount currency must be a non-empty string')
  return Object.freeze({ value, scale, currency })
}

export function zeroMoney(currency: string, scale = 2): MoneyAmount {
  return moneyAmount(0, scale, currency)
}

/**
 * The exact sum of amounts in one currency, at the largest scale among them
 * (1.5 + 0.25 = 1.75). Throws on mixed currencies, or when the sum leaves the
 * safe-integer range.
 */
export function sumMoney(amounts: readonly MoneyAmount[], currency: string): MoneyAmount {
  if (amounts.some((a) => a.currency !== currency)) {
    throw new Error(`sumMoney: every amount must be in ${currency}`)
  }
  const scale = Math.max(0, ...amounts.map((a) => a.scale))
  const total = amounts.reduce(
    (sum, a) => sum + BigInt(a.value) * 10n ** BigInt(scale - a.scale),
    0n,
  )
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('sumMoney: the sum is beyond the safe-integer range')
  }
  return moneyAmount(Number(total), amounts.length === 0 ? 2 : scale, currency)
}

/** The amount as a plain number (1234 at scale 2 → 12.34), for display and conversion only. */
export function moneyToNumber(amount: MoneyAmount): number {
  return amount.value / 10 ** amount.scale
}
