import type { ExchangeRate } from '@/db/types'

// PLACEHOLDER — how exchange rates are applied is not decided yet (which
// provider wins, which date counts, whether cross rates are fine, when a rate
// is too old). Until it is, conversions for display follow these rules:
//
//   1. Only the newest date that has any rates is used, for every conversion
//      ("now" amounts such as account balances).
//   2. On that date, providers are tried by name, ascending; within a
//      provider, rows by base currency. The first row that can convert wins.
//   3. A row converts between any two currencies it lists, through its base:
//      rates[c] is how much of c one unit of the base buys (the base is 1).
//   4. Nothing can convert → null; the UI shows that the rate is missing.
//
// Converted amounts are approximations for display — never stored, never
// added to the money in an account.

export class RateTable {
  private constructor(
    /** The rows of one date, in the order they are tried. */
    private readonly rows: readonly ExchangeRate[],
  ) {}

  static readonly empty = new RateTable([])

  /** A table from `rows`, keeping only those of the newest date among them. */
  static fromRows(rows: readonly ExchangeRate[]): RateTable {
    const newest = rows.reduce<string | null>(
      (d, r) => (d === null || r.date > d ? r.date : d),
      null,
    )
    const sameDay = rows.filter((r) => r.date === newest)
    sameDay.sort((a, b) =>
      a.provider === b.provider
        ? a.base_currency.localeCompare(b.base_currency)
        : a.provider.localeCompare(b.provider),
    )
    return new RateTable(sameDay)
  }

  /** The date the rates are from, or null when there are none. */
  get date(): string | null {
    return this.rows[0]?.date ?? null
  }

  /** `value` of `from` in `to`, or null when no row can convert it. */
  convert(value: number, from: string, to: string): number | null {
    if (from === to) return value
    for (const row of this.rows) {
      const rateOf = (c: string) => (c === row.base_currency ? 1 : row.rates[c])
      const fromRate = rateOf(from)
      const toRate = rateOf(to)
      if (fromRate && toRate) return (value / fromRate) * toRate
    }
    return null
  }
}
