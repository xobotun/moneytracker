import type { MoneyAmount } from './MoneyAmount'
import type { LocalMoment } from './LocalMoment'
import type { UUID } from './uuid'

// Domain entity types — these are what the rest of the app sees.
//
// PREFER MORE SPECIFIC TYPES OVER PRIMITIVES at this layer:
//   - identifiers      → `UUID` (branded string), not raw `string`
//   - instants         → `Date`, not raw `string`
//   - money            → `MoneyAmount`, not three loose fields
//   - civil moments    → `LocalMoment`, not raw `string`
//
// SQLite stores everything as TEXT/INTEGER/REAL/BLOB; the conversion happens
// at the repository boundary using helpers in `./columnMappers.ts`
// (`instantFromColumn`, `uuidFromColumn`, `moneyFromRow`, `localMomentFromRow`,
// `jsonArrayFromColumn`, …) on read and their `*ToColumn(s)` counterparts on
// write. Add new value types here and a matching pair of mappers there —
// repositories should never deal with raw `string` ISO timestamps or raw
// UUID strings if a richer type exists for the concept.

export interface Location {
  id: UUID
  name: string
  description: string | null
  address: string | null
  city: string | null
  country: string | null
  latitude: number | null
  longitude: number | null
  tags: string[]
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

export interface Tag {
  tag: string                          // natural string PK, not a UUID
  description: string | null
  synonyms: string[]
  colour: string
  icon: string
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

export interface Account {
  id: UUID
  name: string
  balance: MoneyAmount
  tags: string[]
  location_id: UUID | null
  colour: string
  icon: string
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

export interface ExchangeRate {
  id: UUID
  date: string                         // 'YYYY-MM-DD' calendar date, not an Instant
  base_currency: string
  rates: Record<string, number>
  provider: string
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

export interface AccountGrouping {
  id: UUID
  name: string
  colour: string
  icon: string
  accounts_ids: UUID[]
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}

export interface Transaction {
  id: UUID
  account_id__from: UUID | null
  account_id__to: UUID | null
  amount__from: MoneyAmount
  amount__to: MoneyAmount
  transaction_at: LocalMoment
  date_override: LocalMoment | null
  tags: string[]
  location_lat: number | null
  location_lon: number | null
  location_id: UUID | null
  created_at_utc: Date
  updated_at_utc: Date
  deleted_at_utc: Date | null
}
