import type { ShortId } from '@/db/shortId'
import type { Tag, TagDetailValues } from '@/db/types'

// Journeys as the Tags page shows them: the currency a journey passes down
// its tree.

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
