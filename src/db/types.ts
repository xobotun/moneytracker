import type { MoneyAmount } from './MoneyAmount'
import type { LocalMoment } from './LocalMoment'

export interface Location {
  id: string
  name: string
  description: string | null
  address: string | null
  city: string | null
  country: string | null
  latitude: number | null
  longitude: number | null
  tags: string[]
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface Tag {
  tag: string
  description: string | null
  synonyms: string[]
  colour: string
  icon: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface Account {
  id: string
  name: string
  balance: MoneyAmount
  tags: string[]
  location_id: string | null
  colour: string
  icon: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface ExchangeRate {
  id: string
  date: string                          // 'YYYY-MM-DD'
  base_currency: string
  rates: Record<string, number>
  provider: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface AccountGrouping {
  id: string
  name: string
  colour: string
  icon: string
  accounts_ids: string[]
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface Transaction {
  id: string
  account_id__from: string | null
  account_id__to: string | null
  amount__from: MoneyAmount
  amount__to: MoneyAmount
  transaction_at: LocalMoment
  date_override: LocalMoment | null
  tags: string[]
  location_lat: number | null
  location_lon: number | null
  location_id: string | null
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}
