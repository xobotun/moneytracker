import type { AppliedRate, ExchangeRate } from '@/db/types'

// The rates of one day, for converting amounts on screen. Built from that
// day's `applied_rates` rows — the rates resolved by the rules in
// docs/plans/2026-10-25-exchange-rates-decisions.md (see resolveRate.ts and
// rateService.ts), or the user's overrides.
//
// Converted amounts are approximations for display — never stored, never
// added to the money in an account.

type Lookup = (from: string, to: string) => number | null

export class RateTable {
  private constructor(
    /** Units of `to` per one `from`, or null; never asked for one currency. */
    private readonly rateOf: Lookup,
  ) {}

  static readonly empty = new RateTable(() => null)

  /** A table over one day's applied rates (pairs stored alphabetically). */
  static fromApplied(rows: readonly AppliedRate[]): RateTable {
    const rates = new Map(rows.map((r) => [`${r.currency_a}>${r.currency_b}`, r.rate]))
    return new RateTable((from, to) => {
      const rate = from < to ? rates.get(`${from}>${to}`) : rates.get(`${to}>${from}`)
      if (rate === undefined || rate === null) return null
      return from < to ? rate : 1 / rate
    })
  }

  /**
   * PLACEHOLDER, removed once the Accounts page reads applied rates: the newest
   * date's reference rows, providers by name, converted through a row's base.
   */
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
    return new RateTable((from, to) => {
      for (const row of sameDay) {
        const rateOf = (c: string) => (c === row.base_currency ? 1 : row.rates[c])
        const fromRate = rateOf(from)
        const toRate = rateOf(to)
        if (fromRate && toRate) return toRate / fromRate
      }
      return null
    })
  }

  /** `value` of `from` in `to`, or null when there is no rate for the pair. */
  convert(value: number, from: string, to: string): number | null {
    if (from === to) return value
    const rate = this.rateOf(from, to)
    return rate === null ? null : value * rate
  }
}
