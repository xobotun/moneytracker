import type { ShortId } from '@/db/shortId'
import type { Tag, TagDetailValues } from '@/db/types'
import type { JourneyDates } from '@/db/repositories/TagDetailsRepository'
import { byName } from './tree'

// Journeys as the Tags page shows them: the currency a journey passes down
// its tree, and their order by date.

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
