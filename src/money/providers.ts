import type { ExchangeRate } from '@/db/types'
import { createFawazahmed0 } from './providers/fawazahmed0'
import { MANUAL_PROVIDER } from './levels'

/** A reference-rate row as a provider publishes it, before it is stored. */
export type ExchangeRateInput = Omit<
  ExchangeRate,
  'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'
>

/**
 * A source of reference rates. Providers are asked in `priority` order, lower
 * first; providers with the same priority form one level, and a level answers
 * as a whole (see resolveRate). The numbers come from PROVIDER_LEVELS
 * (levels.ts): manual 0, central banks 10, fawazahmed0 20, openexchangerates 30.
 */
export interface RateProvider {
  readonly id: string
  readonly priority: number
  /**
   * The rows it publishes for `date` (for a recent date, its newest ones, dated
   * as published); [] when it has none. Rejects on network or server errors.
   * `today` is the device's date.
   */
  fetchDay(date: string, today: string): Promise<ExchangeRateInput[]>
}

/**
 * The level of the provider named in a rate: 0 for manual, the first of
 * 'p1+p2' for a cross over two, Infinity for none or an unknown one.
 */
export function levelOf(provider: string | null, providers: readonly RateProvider[]): number {
  if (provider === null) return Infinity
  if (provider === MANUAL_PROVIDER) return 0
  const first = provider.split('+')[0]
  return providers.find((p) => p.id === first)?.priority ?? Infinity
}

/** The providers the app asks, in any order (their priorities order them). */
export const PROVIDERS: readonly RateProvider[] = [createFawazahmed0()]

/** The best level the providers offer (manual aside). */
export function topLevel(providers: readonly RateProvider[]): number {
  return Math.min(...providers.map((p) => p.priority))
}
