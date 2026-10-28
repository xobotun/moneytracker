import { describe, it, expect } from 'vitest'
import { asShortId, type ShortId } from '@/db/shortId'
import {
  byJourneyDate,
  currentJourney,
  effectiveCurrency,
  freeName,
  inheritedCurrency,
  monthSpanLabel,
  newParentName,
} from '../journeys'
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

describe('currentJourney', () => {
  const TODAY = '2026-10-28'
  const span = (entries: Record<string, [string | null, string | null]>) =>
    new Map(Object.entries(entries).map(([id, [start, end]]) => [asShortId(id), { start, end }]))
  const current = (tags: Parameters<typeof buildTree>[0], dates: ReturnType<typeof span>) =>
    currentJourney(buildTree(tags, 'journey'), dates, TODAY)?.id ?? null

  it('is a journey whose dates hold today: started, and not ended before today', () => {
    const tags = [journey('past'), journey('open'), journey('future')]
    expect(
      current(tags, span({ past: ['2026-01-01', '2026-10-27'], open: ['2026-10-01', null] })),
    ).toBe('open')
    // The first and the last day count.
    expect(current(tags, span({ past: ['2026-10-28', '2026-10-28'] }))).toBe('past')
    expect(current(tags, span({ future: ['2026-10-29', null] }))).toBeNull()
    // No start yet (being planned): not under way.
    expect(current(tags, span({ open: [null, '2026-12-01'] }))).toBeNull()
    expect(current(tags, span({}))).toBeNull()
  })

  it('is the deepest such journey, the most specific', () => {
    const tags = [
      journey('caucasus'),
      journey('georgia', 'caucasus'),
      journey('tbilisi', 'georgia'),
      journey('lisbon'),
    ]
    const dates = span({
      caucasus: ['2026-09-01', null],
      georgia: ['2026-10-01', null],
      tbilisi: ['2026-10-20', null],
      lisbon: ['2026-10-25', null], // later, but at the top level
    })
    expect(current(tags, dates)).toBe('tbilisi')
  })

  it('among equally deep ones, the one that started later, then ends later, then by name and id', () => {
    const tags = [
      journey('trip'),
      journey('old', 'trip'),
      journey('new', 'trip'),
      tag('b2', { kind: 'journey', name: 'B', parent_id: asShortId('trip') }),
      tag('b1', { kind: 'journey', name: 'B', parent_id: asShortId('trip') }),
    ]
    // Continue journey ends the old one today and starts the new one today.
    expect(
      current(
        tags,
        span({
          trip: ['2026-09-01', TODAY],
          old: ['2026-09-01', TODAY],
          new: [TODAY, null],
        }),
      ),
    ).toBe('new')
    // Continued on the day it started: the one that ends today gives way.
    expect(current(tags, span({ old: [TODAY, TODAY], new: [TODAY, null] }))).toBe('new')
    expect(current(tags, span({ old: [TODAY, '2026-11-02'], new: [TODAY, '2026-11-01'] }))).toBe(
      'old',
    )
    expect(current(tags, span({ b2: [TODAY, null], b1: [TODAY, null], new: [TODAY, null] }))).toBe(
      'b1',
    )
  })

  it('leaves out archived journeys', () => {
    const tags = [
      journey('trip'),
      tag('leg', { kind: 'journey', parent_id: asShortId('trip'), archived_at_utc: new Date() }),
    ]
    expect(current(tags, span({ trip: ['2026-10-01', null], leg: ['2026-10-20', null] }))).toBe(
      'trip',
    )
  })
})

describe('monthSpanLabel', () => {
  it('names one month, months of one year, or months across years', () => {
    expect(monthSpanLabel('2026-10-01', '2026-10-28')).toBe('Oct 2026')
    expect(monthSpanLabel('2026-07-14', '2026-10-28')).toBe('Jul–Oct 2026')
    expect(monthSpanLabel('2025-12-20', '2026-01-05')).toBe('Dec 2025–Jan 2026')
    expect(monthSpanLabel('2024-01-01', '2026-12-31')).toBe('Jan 2024–Dec 2026')
  })

  it('takes the dates in either order', () => {
    expect(monthSpanLabel('2026-10-28', '2026-07-14')).toBe('Jul–Oct 2026')
  })
})

describe('freeName', () => {
  it('is the name when no other has it, ignoring case', () => {
    expect(freeName('Oct 2026', ['Summer', 'Oct 2025'])).toBe('Oct 2026')
  })

  it('adds the first free number from 2 up', () => {
    expect(freeName('Oct 2026', ['oct 2026'])).toBe('Oct 2026 (2)')
    expect(freeName('Oct 2026', ['Oct 2026', 'Oct 2026 (2)', 'OCT 2026 (3)'])).toBe('Oct 2026 (4)')
  })
})

describe('newParentName', () => {
  it('names the months from the start to today, free at the top level', () => {
    const top = [{ name: 'Summer', synonyms: ['Jul–Oct 2026'] }]
    expect(newParentName('2026-07-14', '2026-10-28', top)).toBe('Jul–Oct 2026 (2)')
    expect(newParentName('2025-12-20', '2026-01-05', top)).toBe('Dec 2025–Jan 2026')
    // No start known, or one after today: this month.
    expect(newParentName(null, '2026-10-28', top)).toBe('Oct 2026')
    expect(newParentName('2026-11-02', '2026-10-28', top)).toBe('Oct 2026')
  })
})
