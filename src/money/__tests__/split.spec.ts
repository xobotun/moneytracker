import { describe, it, expect } from 'vitest'
import { moneyAmount, moneyToNumber, sumMoney, type MoneyAmount } from '@/db/MoneyAmount'
import {
  addPart,
  displayAmount,
  emptySplit,
  recompute,
  resetPart,
  typePart,
  typeTotal,
  type SplitState,
} from '../split'

const RATE = 398
const eur = (value: number, scale = 2) => moneyAmount(value, scale, 'EUR')
const amd = (value: number, scale = 2) => moneyAmount(value, scale, 'AMD')

function solve(s: SplitState) {
  return recompute(s, RATE)
}

/** value/scale pair, so a test reads "1.005000" without caring about the frozen object. */
function vs(a: MoneyAmount) {
  return [a.value, a.scale]
}

function part(s: SplitState, key: string) {
  const found = s.parts.find((p) => p.key === key)
  if (!found) throw new Error(`no part ${key}`)
  return found
}

describe('split calculator', () => {
  it("derives the total's other side from the market rate", () => {
    const { state } = solve(typeTotal(emptySplit('EUR', 'AMD'), 'to', amd(80000)))
    expect(vs(state.total.from)).toEqual([201, 2])
    expect(state.total.to).toEqual(amd(80000))
    expect(state.totalTyped).toEqual({ from: false, to: true })
  })

  it('shares untouched parts equally at extra precision', () => {
    let s = typeTotal(emptySplit('EUR', 'AMD'), 'to', amd(80000))
    s = addPart(addPart(s, 'groceries'), 'gifts')
    const { state, warnings } = solve(s)
    for (const key of ['groceries', 'gifts']) {
      expect(vs(part(state, key).amounts.from)).toEqual([1005000, 6])
      expect(vs(part(state, key).amounts.to)).toEqual([400000000, 6])
    }
    expect(warnings).toEqual([])
    expect(displayAmount(part(state, 'gifts').amounts.from)).toEqual(eur(100))
  })

  it('walks the worked example of the spec', () => {
    // Steps 1-2
    let s = typeTotal(emptySplit('EUR', 'AMD'), 'to', amd(80000))
    s = addPart(addPart(s, 'groceries'), 'gifts')
    let r = solve(s)
    expect(r.warnings).toEqual([])

    // Step 3: Gifts to = 600 AMD
    s = typePart(r.state, 'gifts', 'to', amd(60000))
    r = solve(s)
    expect(vs(part(r.state, 'gifts').amounts.from)).toEqual([1507500, 6])
    expect(vs(part(r.state, 'groceries').amounts.from)).toEqual([502500, 6])
    expect(vs(part(r.state, 'groceries').amounts.to)).toEqual([200000000, 6])
    expect(displayAmount(part(r.state, 'gifts').amounts.from)).toEqual(eur(151))
    expect(displayAmount(part(r.state, 'groceries').amounts.from)).toEqual(eur(50))
    expect(r.warnings).toEqual([])

    // Step 4: total from = 2.21 EUR
    s = typeTotal(r.state, 'from', eur(221))
    r = solve(s)
    expect(r.state.total.from).toEqual(eur(221))
    expect(vs(part(r.state, 'gifts').amounts.from)).toEqual([1657500, 6])
    expect(vs(part(r.state, 'groceries').amounts.from)).toEqual([552500, 6])
    expect(displayAmount(part(r.state, 'gifts').amounts.from)).toEqual(eur(166))
    expect(displayAmount(part(r.state, 'groceries').amounts.from)).toEqual(eur(55))
    expect(r.warnings).toEqual([])

    // Step 5: Groceries from = 0.60 EUR
    s = typePart(r.state, 'groceries', 'from', eur(60))
    r = solve(s)
    expect(vs(part(r.state, 'gifts').amounts.from)).toEqual([1610000, 6])
    expect(vs(part(r.state, 'groceries').amounts.to)).toEqual([200000000, 6])
    expect(displayAmount(part(r.state, 'gifts').amounts.from)).toEqual(eur(161))
    expect(r.warnings).toHaveLength(1)
    const keys = r.warnings.flatMap((w) => (w.kind === 'rate-mismatch' ? w.keys : []))
    expect(new Set(keys)).toEqual(new Set(['groceries', 'gifts']))
    // The sums still win on both sides.
    const sides = ['from', 'to'] as const
    for (const side of sides) {
      const total = r.state.parts.map((p) => p.amounts[side])
      const currency = side === 'from' ? 'EUR' : 'AMD'
      expect(moneyToNumber(sumMoney(total, currency))).toBeCloseTo(
        moneyToNumber(r.state.total[side]),
        9,
      )
    }
  })

  it('absorbs rounding in the last free part', () => {
    let s = typeTotal(emptySplit('EUR', 'EUR'), 'from', eur(100))
    s = typeTotal(s, 'to', eur(100))
    s = addPart(addPart(addPart(s, 'a'), 'b'), 'c')
    const { state } = solve(s)
    for (const side of ['from', 'to'] as const) {
      expect(state.parts.map((p) => vs(p.amounts[side]))).toEqual([
        [333333, 6],
        [333333, 6],
        [333334, 6],
      ])
      const sum = sumMoney(
        state.parts.map((p) => p.amounts[side]),
        'EUR',
      )
      expect(vs(sum)).toEqual([1000000, 6])
    }
  })

  it('warns when typed parts do not add up', () => {
    let s = typeTotal(emptySplit('EUR', 'AMD'), 'to', amd(80000))
    s = typeTotal(s, 'from', eur(221))
    s = typePart(typePart(addPart(addPart(s, 'a'), 'b'), 'a', 'from', eur(100)), 'b', 'from', eur(100))
    const { warnings } = solve(s)
    expect(warnings).toContainEqual({ kind: 'sum-mismatch', side: 'from', difference: eur(21) })
    expect(warnings.filter((w) => w.kind === 'sum-mismatch')).toHaveLength(1)
  })

  it('treats anchored parts as free when a total is zero', () => {
    // No total typed and no rate: both totals are zero, so the typed 600 AMD anchors nothing.
    let s = addPart(addPart(emptySplit('EUR', 'AMD'), 'a'), 'b')
    s = typePart(s, 'a', 'to', amd(60000))
    const { state, warnings } = recompute(s, null)
    expect(state.total.from.value).toBe(0)
    expect(vs(part(state, 'a').amounts.from)).toEqual([0, 6])
    expect(vs(part(state, 'b').amounts.from)).toEqual([0, 6])
    expect(warnings).toEqual([])
  })

  it('resetPart makes a typed value derived again', () => {
    let s = typeTotal(emptySplit('EUR', 'AMD'), 'to', amd(80000))
    s = addPart(addPart(s, 'groceries'), 'gifts')
    s = typePart(s, 'gifts', 'to', amd(60000))
    expect(part(s, 'gifts').typed).toEqual({ from: false, to: true })
    s = resetPart(s, 'gifts', 'to')
    expect(part(s, 'gifts').typed).toEqual({ from: false, to: false })
    const { state } = solve(s)
    expect(vs(part(state, 'gifts').amounts.to)).toEqual([400000000, 6])
  })
})
