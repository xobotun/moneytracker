import { shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { getAppliedRatesRepository, getRateService } from '@/db/init'
import { todayLocal } from '@/money/dates'
import { RateTable } from '@/money/rates'

/**
 * Today's exchange rates, for showing amounts in the base currency. The table
 * is re-read from `applied_rates` after every change, like the write-through
 * stores; the rates themselves are resolved and fetched by the RateService.
 * "Today" is the device's date at the time of each call.
 */
export const useRatesStore = defineStore('rates', () => {
  const table = shallowRef(RateTable.empty)
  // The pairs last asked for, so a refresh can resolve them for a new day.
  let pairs: readonly (readonly [string, string])[] = []

  async function load(): Promise<void> {
    table.value = RateTable.fromApplied(await getAppliedRatesRepository().listForDate(todayLocal()))
  }

  /** Resolves today's rate for each pair (fetching what is missing), then reloads. */
  async function ensure(wanted: readonly (readonly [string, string])[]): Promise<void> {
    pairs = wanted
    await getRateService().ensure(todayLocal(), wanted)
    await load()
  }

  /**
   * Fetches the newest rates, then resolves the pairs in use for today — which
   * may be a new day since they were asked for. Returns the newest date held.
   * Rejects when no source answered.
   */
  async function refresh(): Promise<string | null> {
    const { newest } = await getRateService().refresh()
    await ensure(pairs)
    return newest
  }

  /** Refreshes when the newest rates are older than yesterday (at app start). */
  async function refreshIfStale(): Promise<void> {
    if (await getRateService().isStale()) await refresh()
  }

  return { table, load, ensure, refresh, refreshIfStale }
})
