import type { AppliedRate, ExchangeRate } from '@/db/types'
import { addDays } from './dates'
import { MANUAL_PROVIDER, rankOf } from './levels'
import { levelOf, topLevel, type RateProvider } from './providers'

// How the rate for a currency pair on a day is chosen from the reference rates
// (see docs/plans/2026-10-25-exchange-rates-decisions.md):
//
//   - Provider levels are tried in priority order; the first level that can
//     answer wins, even when a lower level has a direct rate.
//   - Within a level, a direct rate (a row whose base is one currency of the
//     pair and that lists the other, either way round) beats a cross through
//     one intermediate currency. The two legs of a cross may come from
//     different providers of the level.
//   - The newest rate on or before the day counts, up to LOOKBACK_DAYS back.

export const LOOKBACK_DAYS = 7

/** A resolved rate: `rate` units of the second currency per one of the first. */
export interface Resolution {
  rate: number
  /** The provider, or 'p1+p2' for a cross whose legs come from two. */
  provider: string
  /** The intermediate currency of a cross; null for a direct rate. */
  via: string | null
  /** The day the data comes from; for a cross, its older leg's. */
  referenceDate: string
}

interface Edge {
  rate: number
  provider: string
  date: string
}

/** Direct rates from → to, the newest per pair, from one level's rows. */
function edgesOf(
  rows: readonly ExchangeRate[],
  order: readonly string[],
): Map<string, Map<string, Edge>> {
  const sorted = [...rows].sort((x, y) =>
    x.date === y.date
      ? order.indexOf(x.provider) - order.indexOf(y.provider)
      : x.date < y.date
        ? 1
        : -1,
  )
  const edges = new Map<string, Map<string, Edge>>()
  const add = (from: string, to: string, edge: Edge) => {
    let out = edges.get(from)
    if (!out) edges.set(from, (out = new Map()))
    if (!out.has(to)) out.set(to, edge)
  }
  for (const row of sorted) {
    for (const [code, value] of Object.entries(row.rates)) {
      if (code === row.base_currency || !Number.isFinite(value) || value <= 0) continue
      add(row.base_currency, code, { rate: value, provider: row.provider, date: row.date })
      add(code, row.base_currency, { rate: 1 / value, provider: row.provider, date: row.date })
    }
  }
  return edges
}

/** `from` → `to` on `date` from the rows of the providers at `level` alone. */
export function resolveAtLevel(
  date: string,
  from: string,
  to: string,
  rows: readonly ExchangeRate[],
  providers: readonly RateProvider[],
  level: number,
): Resolution | null {
  const ids = providers.filter((p) => p.priority === level).map((p) => p.id)
  const earliest = addDays(date, -LOOKBACK_DAYS)
  const inWindow = rows.filter(
    (r) => ids.includes(r.provider) && r.date >= earliest && r.date <= date,
  )
  const edges = edgesOf(inWindow, ids)

  const direct = edges.get(from)?.get(to)
  if (direct) {
    return { rate: direct.rate, provider: direct.provider, via: null, referenceDate: direct.date }
  }

  let best: Resolution | null = null
  for (const [via, first] of edges.get(from) ?? []) {
    const second = via === to ? undefined : edges.get(via)?.get(to)
    if (!second) continue
    const referenceDate = first.date < second.date ? first.date : second.date
    // The freshest cross wins; on a tie, the alphabetically first intermediate.
    if (
      best &&
      (referenceDate < best.referenceDate ||
        (referenceDate === best.referenceDate && via > best.via!))
    ) {
      continue
    }
    best = {
      rate: first.rate * second.rate,
      provider:
        first.provider === second.provider
          ? first.provider
          : `${first.provider}+${second.provider}`,
      via,
      referenceDate,
    }
  }
  return best
}

/** `from` → `to` on `date`: the answer of the first provider level that has one. */
export function resolveRate(
  date: string,
  from: string,
  to: string,
  rows: readonly ExchangeRate[],
  providers: readonly RateProvider[],
): Resolution | null {
  const levels = [...new Set(providers.map((p) => p.priority))].sort((x, y) => x - y)
  for (const level of levels) {
    const found = resolveAtLevel(date, from, to, rows, providers, level)
    if (found) return found
  }
  return null
}

/**
 * Whether a stored row can no longer improve: a manual row, or a direct rate
 * from the top level that is either of its own day or for a day that has
 * settled (before yesterday — no fresher publication will arrive for it).
 */
export function isFinal(
  row: AppliedRate,
  today: string,
  providers: readonly RateProvider[],
): boolean {
  if (row.provider === MANUAL_PROVIDER) return true
  if (row.rate === null || row.via !== null) return false
  if (levelOf(row.provider, providers) !== topLevel(providers)) return false
  return row.reference_date === row.date || row.date < addDays(today, -1)
}

/**
 * Whether `candidate` should replace the stored row: by `rankOf` (never a
 * manual row; always an empty one; a better level, then direct over cross),
 * then a newer reference date — so a row never downgrades. The rank is the
 * one sync conflicts use, so the two never disagree.
 */
export function isBetter(
  candidate: Resolution,
  current: AppliedRate | null,
  providers: readonly RateProvider[],
): boolean {
  if (current === null) return true
  const level = (provider: string) => levelOf(provider, providers)
  const rankNew = rankOf(candidate, level)
  const rankOld = rankOf(current, level)
  if (rankNew !== rankOld) return rankNew > rankOld
  return candidate.referenceDate > (current.reference_date ?? '')
}
