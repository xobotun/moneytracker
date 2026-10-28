import { describe, it, expect } from 'vitest'
import { asShortId, type ShortId } from '@/db/shortId'
import { byJourneyDate, effectiveCurrency, inheritedCurrency } from '../journeys'
import { buildTree } from '../tree'
import { byId, tag } from './fixtures'

const journey = (id: string, parent: string | null = null) =>
  tag(id, { kind: 'journey', parent_id: parent === null ? null : asShortId(parent) })
const currencies = (entries: Record<string, string>) =>
  new Map<ShortId, { currency: string | null }>(
    Object.entries(entries).map(([id, currency]) => [asShortId(id), { currency }]),
  )

describe('effectiveCurrency and inheritedCurrency', () => {
  // Caucasus (GEL) > Armenia (AMD) > Yerevan; Caucasus > Tbilisi; Summer (none).
  const caucasus = journey('caucasus')
  const armenia = journey('armenia', 'caucasus')
  const yerevan = journey('yerevan', 'armenia')
  const tbilisi = journey('tbilisi', 'caucasus')
  const summer = journey('summer')
  const all = byId(caucasus, armenia, yerevan, tbilisi, summer)
  const details = currencies({ caucasus: 'GEL', armenia: 'AMD' })

  it("is a journey's own currency, else the nearest one above it", () => {
    expect(effectiveCurrency(caucasus, all, details)).toEqual({ currency: 'GEL', from: caucasus })
    expect(effectiveCurrency(armenia, all, details)).toEqual({ currency: 'AMD', from: armenia })
    expect(effectiveCurrency(yerevan, all, details)).toEqual({ currency: 'AMD', from: armenia })
    expect(effectiveCurrency(tbilisi, all, details)).toEqual({ currency: 'GEL', from: caucasus })
    expect(effectiveCurrency(summer, all, details)).toEqual({ currency: null, from: null })
  })

  it('is what a journey that sets none inherits under a parent', () => {
    expect(inheritedCurrency(armenia.id, all, details)).toEqual({ currency: 'AMD', from: armenia })
    expect(inheritedCurrency(tbilisi.id, all, details)).toEqual({
      currency: 'GEL',
      from: caucasus,
    })
    expect(inheritedCurrency(null, all, details)).toEqual({ currency: null, from: null })
    expect(inheritedCurrency(summer.id, all, details)).toEqual({ currency: null, from: null })
  })

  it('survives a parent loop that sync left', () => {
    const x = journey('x', 'y')
    const y = journey('y', 'x')
    expect(effectiveCurrency(x, byId(x, y), currencies({}))).toEqual({
      currency: null,
      from: null,
    })
  })
})

describe('byJourneyDate', () => {
  const starts = (entries: Record<string, string | null>) =>
    new Map(Object.entries(entries).map(([id, start]) => [asShortId(id), { start }]))

  it('sorts by start date, newest first, undated ones on top, ties by name then id', () => {
    const journeys = [
      journey('lisbon'),
      journey('armenia'),
      journey('planned'),
      journey('georgia'),
      journey('alps'),
      tag('rome-b', { kind: 'journey', name: 'Rome' }),
      tag('rome-a', { kind: 'journey', name: 'Rome' }),
    ]
    const dates = starts({
      lisbon: '2025-07-01',
      armenia: '2024-05-01',
      georgia: '2026-09-15',
      alps: null, // a row with no dates is undated too
      'rome-a': '2025-07-01',
      'rome-b': '2025-07-01',
    })
    expect(journeys.sort(byJourneyDate(dates)).map((j) => j.id)).toEqual([
      'alps',
      'planned',
      'georgia',
      'lisbon',
      'rome-a',
      'rome-b',
      'armenia',
    ])
  })

  it('orders the children of a journey the same way, in the tree', () => {
    const tags = [
      journey('summer'),
      journey('winter'),
      journey('porto', 'summer'),
      journey('lisbon', 'summer'),
    ]
    const dates = starts({
      summer: '2026-07-01',
      winter: '2026-12-20',
      porto: '2026-07-10',
      lisbon: '2026-07-01',
    })
    const tree = buildTree(tags, 'journey', byJourneyDate(dates))
    expect(tree.map((n) => [n.tag.id, n.children.map((c) => c.tag.id)])).toEqual([
      ['winter', []],
      ['summer', ['porto', 'lisbon']],
    ])
  })
})
