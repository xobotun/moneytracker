import type { MoneyAmount } from './MoneyAmount'
import type { LocalMoment } from './LocalMoment'
import type { UUID } from './uuid'
import type { ShortId } from './shortId'

// Domain entity types — these are what the rest of the app sees.
//
// PREFER MORE SPECIFIC TYPES OVER PRIMITIVES at this layer:
//   - identifiers      → `UUID` / `ShortId` (branded strings), not raw `string`
//   - instants         → `Date`, not raw `string`
//   - money            → `MoneyAmount`, not three loose fields
//   - civil moments    → `LocalMoment`, not raw `string`
//
// SQLite stores everything as TEXT/INTEGER/REAL/BLOB; the conversion happens
// at the repository boundary using helpers in `./columnMappers.ts`
// (`instantFromColumn`, `uuidFromColumn`, `shortIdFromColumn`, `moneyFromRow`,
// `localMomentFromRow`, `jsonArrayFromColumn`, …) on read and their
// `*ToColumn(s)` counterparts on write. Add new value types here and a
// matching pair of mappers there — repositories should never deal with raw
// `string` ISO timestamps or raw id strings if a richer type exists for the
// concept.

/**
 * What a tag answers on a transaction (see the category-vs-tag decisions):
 * what kind of spending (category), who was paid (merchant), where (location),
 * which trip (journey), or anything else (a plain tag, shown as `#tag`).
 * Fixed in code; a tag never changes its kind.
 */
export type TagKind = 'category' | 'merchant' | 'location' | 'journey' | 'tag'

export interface Tag {
  id: ShortId
  kind: TagKind
  name: string // unique among live tags of the same kind and parent, synonyms included (case-insensitive)
  parent_id: ShortId | null // a tag of the same kind; null = top level
  moved_at_utc: Date // when the user last set parent_id: on create, move, or a merge of the parent; repairs leave it
  description: string | null
  synonyms: string[] // extra names that find the tag; transactions show `name`
  retired_names: string[] // names that no longer find the tag through a tag merged into it (src/tags/otherNames.ts)
  colour: string | null // null = inherited from the parent (see src/tags/look.ts)
  icon: string | null // PrimeIcons name without `pi-`; null = inherited from the parent
  merged_into_id: ShortId | null // the tag this one was merged into (then also deleted); null = not merged
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

/** Side data of a `location` tag: where it is, and the merchant a store belongs to. */
export interface LocationDetails {
  tag_id: ShortId
  address: string | null
  latitude: number | null // WGS84 degrees
  longitude: number | null // WGS84 degrees
  merchant_id: ShortId | null // a `merchant` tag; null = none
}

/** Side data of a `merchant` tag. */
export interface MerchantDetails {
  tag_id: ShortId
  default_category_id: ShortId | null // a `category` tag suggested for its transactions; null = none
}

/** Side data of a `journey` tag: dates the user typed over the derived ones. */
export interface JourneyDetails {
  tag_id: ShortId
  start_date: string | null // 'YYYY-MM-DD'; null = derived from the journey's transactions
  end_date: string | null // 'YYYY-MM-DD'; null = derived from the journey's transactions
}

/** A tag's details as one value set; a field its kind does not have stays null. */
export interface TagDetailValues {
  address: string | null
  position: { latitude: number; longitude: number } | null // the two coordinates as one value
  merchant_id: ShortId | null
  default_category_id: ShortId | null
  start_date: string | null
  end_date: string | null
}
export type TagDetailField = keyof TagDetailValues
export interface TagDetailConflict<F extends TagDetailField = TagDetailField> {
  field: F
  source: TagDetailValues[F]
  target: TagDetailValues[F]
}

export interface Account {
  id: ShortId
  name: string
  balance: MoneyAmount
  is_cash: boolean // money in hand (a wallet), not in a bank; reports split cash from non-cash by it
  tags: ShortId[] // plain tags (kind 'tag')
  location_id: ShortId | null // a `location` tag
  colour: string
  icon: string
  grouping_id: ShortId | null // the account's group; null = shown below all groups
  sort_order: number // position within its group; set by create(), update() of grouping_id and arrange()
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

export interface ExchangeRate {
  id: UUID
  date: string // 'YYYY-MM-DD' calendar date, not an Instant
  base_currency: string
  rates: Record<string, number>
  provider: string
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

/**
 * The rate the app uses for one day and one currency pair — resolved from the
 * reference rates (`ExchangeRate`) or entered by hand (provider 'manual').
 * One row per (date, currency_a, currency_b) with currency_a < currency_b.
 */
export interface AppliedRate {
  id: UUID
  date: string // 'YYYY-MM-DD' the day the rate applies to
  currency_a: string
  currency_b: string
  rate: number | null // units of currency_b per 1 currency_a; null = none found
  provider: string | null // 'manual', a provider id, or 'p1+p2' for a cross over two; null = none found
  via: string | null // the intermediate currency of a cross rate; null = direct
  reference_date: string | null // 'YYYY-MM-DD' the data comes from; null = none found
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

export interface AccountGrouping {
  id: ShortId
  name: string
  colour: string
  icon: string
  sort_order: number // position among the groups; set by create() and reorder() only
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

/**
 * One category's share of a transaction: its part of each side's amount, in
 * the transaction's currencies. Parts may carry more decimals than the
 * currency shows (1.005000 €); rounding is display-only.
 */
export interface CategoryPart {
  category_id: ShortId // a `category` tag
  amount__from: MoneyAmount
  amount__to: MoneyAmount
}

export interface Transaction {
  id: UUID
  account_id__from: ShortId | null
  account_id__to: ShortId | null
  amount__from: MoneyAmount
  amount__to: MoneyAmount
  transaction_at: LocalMoment
  date_override: LocalMoment | null
  tags: ShortId[] // plain tags (kind `tag`)
  categories: CategoryPart[] // at least one, each category once; each side adds up exactly to the transaction's amount
  merchant_id: ShortId | null // a `merchant` tag
  location_lat: number | null
  location_lon: number | null
  location_id: ShortId | null // a `location` tag
  journey_id: ShortId | null // a `journey` tag
  description__user: string | null // the user's free-text note
  description__auto: Record<string, unknown> | null // what an import read (OCR, bank API, statement, ...); null = entered by hand
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}
