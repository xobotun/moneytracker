/**
 * The split calculator behind the transaction form (docs/plans/2026-10-26-category-vs-tag-decisions.md
 * §2.3–2.4): one transaction divided over several category parts, each with a *from* and a *to*
 * amount, some typed by the user and the rest derived.
 *
 * Pure and immutable. The mutators only record what the user typed (and the `typed` flags);
 * `recompute` fills every derived value. All amounts are computed exactly in BigInt on unscaled
 * values and rounded half-to-even; only the market rate is a float.
 */
import { moneyAmount, type MoneyAmount } from '@/db/MoneyAmount'
import { usualDecimals } from '@/format/currency'

export type Side = 'from' | 'to'

export interface SplitAmounts {
  from: MoneyAmount
  to: MoneyAmount
}

/** Which of the two values the user typed (true) rather than the app derived (false). */
export interface Typed {
  from: boolean
  to: boolean
}

export interface SplitPart {
  key: string
  amounts: SplitAmounts
  typed: Typed
}

export interface SplitState {
  total: SplitAmounts
  totalTyped: Typed
  parts: SplitPart[]
}

export type SplitWarning =
  /** The parts no longer all follow the transaction's own rate (the sums won). */
  | { kind: 'rate-mismatch'; keys: string[] }
  /** Every part is typed on this side and they do not add up to the total. */
  | { kind: 'sum-mismatch'; side: Side; difference: MoneyAmount }

/** Parts are kept at the currency's usual decimals plus this many, so shares do not lose cents. */
export const PART_EXTRA_SCALE = 4

const SIDES: readonly Side[] = ['from', 'to']

function other(side: Side): Side {
  return side === 'from' ? 'to' : 'from'
}

function zeroAt(currency: string, scale: number): MoneyAmount {
  return moneyAmount(0, scale, currency)
}

export function emptySplit(currencyFrom: string, currencyTo: string): SplitState {
  return {
    total: {
      from: zeroAt(currencyFrom, usualDecimals(currencyFrom)),
      to: zeroAt(currencyTo, usualDecimals(currencyTo)),
    },
    totalTyped: { from: false, to: false },
    parts: [],
  }
}

export function typeTotal(s: SplitState, side: Side, amount: MoneyAmount): SplitState {
  return {
    ...s,
    total: { ...s.total, [side]: amount },
    totalTyped: { ...s.totalTyped, [side]: true },
  }
}

export function resetTotal(s: SplitState, side: Side): SplitState {
  return { ...s, totalTyped: { ...s.totalTyped, [side]: false } }
}

export function addPart(s: SplitState, key: string): SplitState {
  if (s.parts.some((p) => p.key === key)) throw new Error(`split part "${key}" already exists`)
  const part: SplitPart = {
    key,
    amounts: {
      from: zeroAt(s.total.from.currency, partScale(s.total.from.currency)),
      to: zeroAt(s.total.to.currency, partScale(s.total.to.currency)),
    },
    typed: { from: false, to: false },
  }
  return { ...s, parts: [...s.parts, part] }
}

export function removePart(s: SplitState, key: string): SplitState {
  return { ...s, parts: s.parts.filter((p) => p.key !== key) }
}

function mapPart(s: SplitState, key: string, change: (p: SplitPart) => SplitPart): SplitState {
  if (!s.parts.some((p) => p.key === key)) throw new Error(`no split part "${key}"`)
  return { ...s, parts: s.parts.map((p) => (p.key === key ? change(p) : p)) }
}

export function typePart(s: SplitState, key: string, side: Side, amount: MoneyAmount): SplitState {
  return mapPart(s, key, (p) => ({
    ...p,
    amounts: { ...p.amounts, [side]: amount },
    typed: { ...p.typed, [side]: true },
  }))
}

export function resetPart(s: SplitState, key: string, side: Side): SplitState {
  return mapPart(s, key, (p) => ({ ...p, typed: { ...p.typed, [side]: false } }))
}

/** Rounded to the currency's usual decimals (half-to-even), for display only. */
export function displayAmount(amount: MoneyAmount): MoneyAmount {
  const usual = usualDecimals(amount.currency)
  if (amount.scale <= usual) return amount
  const value = roundDiv(BigInt(amount.value), 10n ** BigInt(amount.scale - usual))
  return moneyAmount(Number(value), usual, amount.currency)
}

// --- exact arithmetic ---------------------------------------------------------------------

function partScale(currency: string): number {
  return usualDecimals(currency) + PART_EXTRA_SCALE
}

/** Array element that is known to exist (the arrays here are index-aligned with the parts). */
function at(list: bigint[], index: number): bigint {
  return list[index] ?? 0n
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n
}

/** n / d rounded half-to-even; d may be of either sign. */
function roundDiv(n: bigint, d: bigint): bigint {
  if (d < 0n) {
    n = -n
    d = -d
  }
  let q = n / d
  const r = n % d // same sign as n
  const twice = 2n * abs(r)
  if (twice > d || (twice === d && q % 2n !== 0n)) q += n < 0n ? -1n : 1n
  return q
}

function units(amount: MoneyAmount, scale: number): bigint {
  return BigInt(amount.value) * 10n ** BigInt(scale - amount.scale)
}

function toAmount(value: bigint, scale: number, currency: string): MoneyAmount {
  return moneyAmount(Number(value), scale, currency)
}

/** A float rate as an exact fraction (15 significant digits), or null when unusable. */
function rateFraction(rate: number | null): { num: bigint; den: bigint } | null {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null
  const [mantissa = '', exponent = '0'] = rate.toExponential(14).split('e')
  const digits = BigInt(mantissa.replace('.', ''))
  const power = Number(exponent) - 14
  return power >= 0
    ? { num: digits * 10n ** BigInt(power), den: 1n }
    : { num: digits, den: 10n ** BigInt(-power) }
}

/** Fills the untyped total side: the typed side at the market rate, rounded to usual decimals. */
function deriveTotal(s: SplitState, marketRate: number | null): SplitAmounts {
  const total = { ...s.total }
  const typed = s.totalTyped
  if (typed.from && typed.to) return total
  for (const side of SIDES) {
    if (typed[side]) continue
    const src = other(side)
    const currency = total[side].currency
    const scale = usualDecimals(currency)
    const fraction = rateFraction(marketRate)
    if (!typed[src] || fraction === null) {
      total[side] = zeroAt(currency, scale)
      continue
    }
    // to = from × rate, from = to ÷ rate; compared at the target scale.
    const value = BigInt(total[src].value)
    const scaleUp = 10n ** BigInt(scale)
    const scaleDown = 10n ** BigInt(total[src].scale)
    const num = side === 'to' ? value * fraction.num * scaleUp : value * fraction.den * scaleUp
    const den = side === 'to' ? fraction.den * scaleDown : fraction.num * scaleDown
    total[side] = toAmount(roundDiv(num, den), scale, currency)
  }
  return total
}

interface SideResult {
  /** By part key. */
  amounts: Map<string, MoneyAmount>
  /** Anchored parts whose value had to leave its ideal because the sums won. */
  mismatched: Set<string>
}

export function recompute(
  s: SplitState,
  marketRate: number | null,
): { state: SplitState; warnings: SplitWarning[] } {
  const total = deriveTotal(s, marketRate)

  // One working scale per side, fine enough for every typed value on it.
  const scales = {} as Record<Side, number>
  for (const side of SIDES) {
    scales[side] = Math.max(
      partScale(total[side].currency),
      total[side].scale,
      ...s.parts.filter((p) => p.typed[side]).map((p) => p.amounts[side].scale),
    )
  }
  const totalUnits = {
    from: units(total.from, scales.from),
    to: units(total.to, scales.to),
  }
  // Rule 7: with either total at zero there is no rate, so nothing is anchored.
  const hasRate = totalUnits.from !== 0n && totalUnits.to !== 0n

  const results = {} as Record<Side, SideResult>
  for (const side of SIDES) {
    const o = other(side)
    const kinds = s.parts.map((p) =>
      p.typed[side] ? 'typed' : p.typed[o] && hasRate ? 'anchored' : 'free',
    )
    // The ideal of an anchored part: the other side at the transaction's own rate.
    const ideal = s.parts.map((p, i) =>
      kinds[i] === 'anchored'
        ? roundDiv(units(p.amounts[o], scales[o]) * totalUnits[side], totalUnits[o])
        : 0n,
    )
    const values = s.parts.map((p, i) =>
      kinds[i] === 'typed' ? units(p.amounts[side], scales[side]) : 0n,
    )

    const typedSum = values.reduce((a, b) => a + b, 0n)
    const anchoredIdx = kinds.flatMap((k, i) => (k === 'anchored' ? [i] : []))
    const freeIdx = kinds.flatMap((k, i) => (k === 'free' ? [i] : []))
    const idealSum = anchoredIdx.reduce((a, i) => a + at(ideal, i), 0n)
    const remainder = totalUnits[side] - typedSum
    const mismatched = new Set<string>()

    if (freeIdx.length > 0) {
      anchoredIdx.forEach((i) => (values[i] = at(ideal, i)))
      share(values, freeIdx, remainder - idealSum, () => 1n)
    } else if (anchoredIdx.length > 0 && idealSum === remainder) {
      anchoredIdx.forEach((i) => (values[i] = at(ideal, i)))
    } else if (anchoredIdx.length > 0) {
      // Rule 5: the sums win; the anchored parts share the difference in proportion to their ideals.
      share(values, anchoredIdx, remainder, (i) => (idealSum === 0n ? 1n : at(ideal, i)))
      const half = 10n ** BigInt(scales[side] - usualDecimals(total[side].currency))
      s.parts.forEach((p, i) => {
        if (kinds[i] === 'anchored' && 2n * abs(at(values, i) - at(ideal, i)) >= half) {
          mismatched.add(p.key)
        }
      })
    }

    results[side] = {
      amounts: new Map(
        s.parts.map((p, i) => [
          p.key,
          kinds[i] === 'typed'
            ? p.amounts[side]
            : toAmount(at(values, i), scales[side], total[side].currency),
        ]),
      ),
      mismatched,
    }
  }

  const state: SplitState = {
    ...s,
    total,
    parts: s.parts.map((p) => ({
      ...p,
      amounts: {
        from: results.from.amounts.get(p.key) ?? p.amounts.from,
        to: results.to.amounts.get(p.key) ?? p.amounts.to,
      },
    })),
  }

  const warnings: SplitWarning[] = []
  const keys = s.parts
    .map((p) => p.key)
    .filter((key) => SIDES.some((side) => results[side].mismatched.has(key)))
  if (keys.length > 0) warnings.push({ kind: 'rate-mismatch', keys })
  for (const side of SIDES) {
    if (s.parts.length === 0 || !s.parts.every((p) => p.typed[side])) continue
    // At the finest scale actually typed, so 2.21 − 2.00 reads 0.21, not 0.210000.
    const scale = Math.max(total[side].scale, ...s.parts.map((p) => p.amounts[side].scale))
    const sum = s.parts.reduce((acc, p) => acc + units(p.amounts[side], scale), 0n)
    const difference = units(total[side], scale) - sum
    if (difference !== 0n) {
      warnings.push({ kind: 'sum-mismatch', side, difference: toAmount(difference, scale, total[side].currency) })
    }
  }
  return { state, warnings }
}

/**
 * Splits `amount` over `indexes` of `values` in proportion to `weight`, each share rounded once
 * and the last one taking what is left, so the shares add up to `amount` exactly.
 */
function share(
  values: bigint[],
  indexes: number[],
  amount: bigint,
  weight: (index: number) => bigint,
): void {
  const weights = indexes.map(weight)
  const weightSum = weights.reduce((a, b) => a + b, 0n)
  let left = amount
  indexes.forEach((index, n) => {
    const part = n === indexes.length - 1 ? left : roundDiv(amount * at(weights, n), weightSum)
    values[index] = part
    left -= part
  })
}
