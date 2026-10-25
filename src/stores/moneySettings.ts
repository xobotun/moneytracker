import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getSettingsRepository } from '@/db/init'
import { settingsKey } from '@/db/SettingsKey'
import { currencyCodeError, normaliseCurrencyCode } from '@/format/currency'

export const DEFAULT_BASE_CURRENCY = 'EUR'

export const MoneyKeys = {
  baseCurrency: settingsKey<string>('money.baseCurrency'),
}

/**
 * Money preferences of this device. The base currency is the one amounts in
 * different currencies are totalled in. Device-local, like every setting (the
 * settings table is not synced).
 *
 * Write-through, as it shapes how money is shown: a new value is persisted
 * first, then applied.
 */
export const useMoneySettingsStore = defineStore('moneySettings', () => {
  const baseCurrency = ref(DEFAULT_BASE_CURRENCY)

  /** Loads the stored value; keeps the default when there is none or it is not a code. */
  async function hydrate(): Promise<void> {
    const stored: unknown = await getSettingsRepository().get(MoneyKeys.baseCurrency)
    if (stored === null) return
    if (typeof stored === 'string' && currencyCodeError(stored) === null) {
      baseCurrency.value = normaliseCurrencyCode(stored)
    } else {
      console.warn(`Ignoring invalid stored setting ${MoneyKeys.baseCurrency.key}:`, stored)
    }
  }

  /** Stores `code` (trimmed, upper-cased); throws, changing nothing, when it is not a code. */
  async function setBaseCurrency(code: string): Promise<void> {
    const error = currencyCodeError(code)
    if (error) throw new Error(error)
    const normalised = normaliseCurrencyCode(code)
    await getSettingsRepository().set(MoneyKeys.baseCurrency, normalised)
    baseCurrency.value = normalised
  }

  return { baseCurrency, hydrate, setBaseCurrency }
})
