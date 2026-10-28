import type { ShortId } from '@/db/shortId'
import type { Tag, TagDetailValues } from '@/db/types'
import type { JourneyDates } from '@/db/repositories/TagDetailsRepository'
import { byName, type TagNode } from './tree'
import { foldCase } from './otherNames'

// Journeys as the Tags page shows them: the currency a journey passes down
// its tree, their order by date, the journey under way today, and the names
// "Continue journey" gives the journey it puts the current one under.

/** A journey's currency and the journey it is set on; both null when none is set up the tree. */
export interface JourneyCurrency {
  currency: string | null
  from: Tag | null
}

type CurrencyDetails = ReadonlyMap<ShortId, Pick<TagDetailValues, 'currency'>>

/**
 * The first currency set on the way up from `start` through its parents,
 * like the look (look.ts), and the journey it is set on. Sync can leave a
 * parent loop until it is repaired: the walk never visits a journey twice.
 */
function currencyFrom(
  start: Tag | undefined,
  byId: ReadonlyMap<ShortId, Tag>,
  details: CurrencyDetails,
): JourneyCurrency {
  const seen = new Set<ShortId>()
  for (let current = start; current && !seen.has(current.id); ) {
    seen.add(current.id)
    const currency = details.get(current.id)?.currency ?? null
    if (currency !== null) return { currency, from: current }
    current = current.parent_id === null ? undefined : byId.get(current.parent_id)
  }
  return { currency: null, from: null }
}

/** The currency a journey uses: its own, else the nearest one set above it. */
export function effectiveCurrency(
  journey: Tag,
  byId: ReadonlyMap<ShortId, Tag>,
  details: CurrencyDetails,
): JourneyCurrency {
  return currencyFrom(journey, byId, details)
}

/**
 * What a journey that sets no currency uses under `parentId` (null: at the
 * top level, where there is nothing to inherit), and where it comes from.
 */
export function inheritedCurrency(
  parentId: ShortId | null,
  byId: ReadonlyMap<ShortId, Tag>,
  details: CurrencyDetails,
): JourneyCurrency {
  return currencyFrom(parentId === null ? undefined : byId.get(parentId), byId, details)
}

/**
 * Journeys by their start date (`dates`: typed or derived, as
 * `allJourneyDates` gives them), newest first; those with no start yet come
 * first, as the ones being planned. Ties by name, then id.
 */
export function byJourneyDate(
  dates: ReadonlyMap<ShortId, Pick<JourneyDates, 'start'>>,
): (a: Tag, b: Tag) => number {
  return (a, b) => {
    const x = dates.get(a.id)?.start ?? null
    const y = dates.get(b.id)?.start ?? null
    if (x !== y) {
      if (x === null) return -1
      if (y === null) return 1
      return x < y ? 1 : -1
    }
    return byName(a, b)
  }
}

/**
 * The journey under way on `today` ('YYYY-MM-DD'): a live, active one of the
 * `tree` whose dates (typed or derived) hold today — a start on or before
 * it, and no end or one on or after it. The deepest such one wins (the most
 * specific: Tbilisi inside Georgia), then the one that started later, then
 * by name and id. Null when there is none.
 */
export function currentJourney(
  tree: readonly TagNode[],
  dates: ReadonlyMap<ShortId, Pick<JourneyDates, 'start' | 'end'>>,
  today: string,
): Tag | null {
  const underWay: { tag: Tag; depth: number; start: string }[] = []
  const visit = (nodes: readonly TagNode[], depth: number) => {
    for (const { tag, children } of nodes) {
      const d = dates.get(tag.id)
      const holdsToday = !!d?.start && d.start <= today && (d.end === null || d.end >= today)
      if (holdsToday && tag.archived_at_utc === null) underWay.push({ tag, depth, start: d.start! })
      visit(children, depth + 1)
    }
  }
  visit(tree, 0)
  underWay.sort(
    (a, b) =>
      b.depth - a.depth ||
      (a.start === b.start ? byName(a.tag, b.tag) : a.start < b.start ? 1 : -1),
  )
  return underWay[0]?.tag ?? null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The months from `start` to `end` ('YYYY-MM-DD', either order) as a name:
 * "Oct 2026", "Jul–Oct 2026", "Dec 2025–Jan 2026". English month names, not
 * the device's language: the name is synced, and both devices make the same.
 */
export function monthSpanLabel(start: string, end: string): string {
  const [from, to] = start <= end ? [start, end] : [end, start]
  const month = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1]!
  const year = (date: string) => date.slice(0, 4)
  if (year(from) !== year(to)) return `${month(from)} ${year(from)}–${month(to)} ${year(to)}`
  if (month(from) !== month(to)) return `${month(from)}–${month(to)} ${year(to)}`
  return `${month(to)} ${year(to)}`
}

/** `name`, or "name (2)", "name (3)" … : the first that none of `taken` is, ignoring case. */
export function freeName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map(foldCase))
  if (!used.has(foldCase(name))) return name
  for (let n = 2; ; n++) {
    const next = `${name} (${n})`
    if (!used.has(foldCase(next))) return next
  }
}

/**
 * The name "Continue journey" gives the parent it makes for a top-level
 * journey that started on `start` (null: not known, taken as today): the
 * months to `today`, free among the names and other names of the top-level
 * journeys `topLevel`.
 */
export function newParentName(
  start: string | null,
  today: string,
  topLevel: readonly Pick<Tag, 'name' | 'synonyms'>[],
): string {
  const from = start !== null && start < today ? start : today
  return freeName(
    monthSpanLabel(from, today),
    topLevel.flatMap((t) => [t.name, ...t.synonyms]),
  )
}
