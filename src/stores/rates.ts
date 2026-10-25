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

  async function load(): Promise<void> {
    table.value = RateTable.fromApplied(await getAppliedRatesRepository().listForDate(todayLocal()))
  }

  /** Resolves today's rate for each pair (fetching what is missing), then reloads. */
  async function ensure(pairs: readonly (readonly [string, string])[]): Promise<void> {
    await getRateService().ensure(todayLocal(), pairs)
    await load()
  }

  /** Fetches the newest rates; returns the newest date held. Rejects when no source answered. */
  async function refresh(): Promise<string | null> {
    const { newest } = await getRateService().refresh()
    await load()
    return newest
  }

  /** Refreshes when the newest rates are older than yesterday (at app start). */
  async function refreshIfStale(): Promise<void> {
    if (await getRateService().isStale()) await refresh()
  }

  return { table, load, ensure, refresh, refreshIfStale }
})
