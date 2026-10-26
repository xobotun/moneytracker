// Which level each rate provider sits on: the order rates are looked for in
// (lower first; equal = one level, see resolveRate.ts) and what a row holds
// in a sync conflict (ROW_RANK). Constants only, so the sync layer and the
// repositories can use them without pulling in any fetching code.

/** The provider name of the user's own rates (overrides in `applied_rates`). */
export const MANUAL_PROVIDER = 'manual'

export const PROVIDER_LEVELS: Readonly<Record<string, number>> = {
  [MANUAL_PROVIDER]: 0,
  // Central banks, read from the rates repo (xobotun/exchange-rates).
  ecb: 10,
  nbg: 10,
  nbk: 10,
  cba: 10,
  cbr: 10,
  fawazahmed0: 20,
  openexchangerates: 30,
}

/** Where a provider no level knows ranks: above "none found", below the rest. */
const UNKNOWN_LEVEL = 999

/** The level of a known provider id, or undefined. A cross 'p1+p2' goes by p1. */
const staticLevel = (provider: string): number | undefined =>
  PROVIDER_LEVELS[provider.split('+')[0]!]

/**
 * How good an applied rate is, as one number (higher is better): the user's
 * own rate above all; then a better level; within a level, direct over cross;
 * then a provider no level knows; "none found" last. The resolver
 * (`isBetter`) and the sync conflict rule (`ROW_RANK`) both use it, so a row
 * one of them prefers is never undone by the other.
 */
export function rankOf(
  row: { provider: string | null; rate: number | null; via: string | null },
  levelOf: (provider: string) => number | undefined = staticLevel,
): number {
  if (row.provider === MANUAL_PROVIDER) return Number.POSITIVE_INFINITY
  if (row.provider === null || row.rate === null) return 0
  const level = Math.min(levelOf(row.provider) ?? UNKNOWN_LEVEL, UNKNOWN_LEVEL)
  return (1000 - level) * 2 + (row.via === null ? 1 : 0)
}
