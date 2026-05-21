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
  if (!Number.isInteger(value)) throw new Error(`MoneyAmount value must be an integer, got ${value}`)
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`MoneyAmount scale must be a non-negative integer, got ${scale}`)
  if (!currency || currency.trim().length === 0) throw new Error('MoneyAmount currency must be a non-empty string')
  return Object.freeze({ value, scale, currency })
}

export function zeroMoney(currency: string, scale = 2): MoneyAmount {
  return moneyAmount(0, scale, currency)
}
