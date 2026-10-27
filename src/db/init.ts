import { shallowRef } from 'vue'
import { Database } from './Database'
import { ALL_MIGRATIONS, runMigrations } from './migrations'
import { SettingsRepository } from './repositories/SettingsRepository'
import { TagsRepository } from './repositories/TagsRepository'
import { TagDetailsRepository } from './repositories/TagDetailsRepository'
import { AccountsRepository } from './repositories/AccountsRepository'
import { ExchangeRatesRepository } from './repositories/ExchangeRatesRepository'
import { AppliedRatesRepository } from './repositories/AppliedRatesRepository'
import { AccountGroupingsRepository } from './repositories/AccountGroupingsRepository'
import { TransactionsRepository } from './repositories/TransactionsRepository'
import { RateService } from '../money/rateService'
import { PROVIDERS } from '../money/providers'
import { todayLocal } from '../money/dates'
import type { SyncBackend } from '../sync/SyncBackend'
import { buildBackend } from '../sync/backendFactory'
import { loadProviderConfig, saveSyncError, type ProviderConfig } from '../sync/localState'

let database: Database | null = null
// shallowRef, not a plain variable: Vue tracks reads of `.value`, so a computed
// such as "is a backend available?" re-evaluates when the provider changes.
// Shallow so the backend object itself is not wrapped in a reactive proxy.
const syncBackend = shallowRef<SyncBackend | null>(null)
let settingsRepository: SettingsRepository | null = null
let tagsRepository: TagsRepository | null = null
let tagDetailsRepository: TagDetailsRepository | null = null
let accountsRepository: AccountsRepository | null = null
let exchangeRatesRepository: ExchangeRatesRepository | null = null
let appliedRatesRepository: AppliedRatesRepository | null = null
let accountGroupingsRepository: AccountGroupingsRepository | null = null
let transactionsRepository: TransactionsRepository | null = null
let rateService: RateService | null = null

export async function initDatabase(): Promise<void> {
  database = new Database()
  await database.init({ filePath: 'moneytracker.db', persist: true })
  await runMigrations(database, ALL_MIGRATIONS)
  settingsRepository = new SettingsRepository(database)
  tagsRepository = new TagsRepository(database)
  tagDetailsRepository = new TagDetailsRepository(database)
  accountsRepository = new AccountsRepository(database)
  exchangeRatesRepository = new ExchangeRatesRepository(database)
  appliedRatesRepository = new AppliedRatesRepository(database)
  accountGroupingsRepository = new AccountGroupingsRepository(database)
  transactionsRepository = new TransactionsRepository(database)
  rateService = new RateService({
    exchangeRates: exchangeRatesRepository,
    appliedRates: appliedRatesRepository,
    providers: PROVIDERS,
    today: () => todayLocal(),
  })

  // Build the sync backend from the stored provider config. null when the
  // user has not configured a provider; Settings.vue's "Sync now" button
  // disables itself in that case.
  applyStoredProviderConfig()
}

export function getDatabase(): Database {
  if (!database) throw new Error('Database not initialized. Call initDatabase() first.')
  return database
}

/** Registers the backend used to sync the local database with the remote (null = sync off). */
export function setSyncBackend(backend: SyncBackend | null): void {
  syncBackend.value = backend
}

/**
 * Returns the registered backend, or null when no provider is configured.
 * Reactive: reading it inside a computed or watcher tracks provider switches.
 */
export function getSyncBackend(): SyncBackend | null {
  return syncBackend.value
}

/** Rebuilds and registers the backend for `cfg`. Call after the provider config changes. */
export function applyProviderConfig(cfg: ProviderConfig): void {
  setSyncBackend(buildBackend(cfg))
}

/**
 * Registers the backend from the stored provider config at app startup.
 * Never throws: sync is optional, so unreadable storage or a malformed config
 * turns sync off (and records why, if storage allows) instead of failing the
 * whole app start.
 */
export function applyStoredProviderConfig(load: () => ProviderConfig = loadProviderConfig): void {
  try {
    applyProviderConfig(load())
  } catch (e) {
    setSyncBackend(null)
    console.warn('Sync disabled: could not load the sync provider settings.', e)
    const reason = e instanceof Error ? e.message : String(e)
    try {
      saveSyncError({
        atUtc: new Date().toISOString(),
        message: `Sync is off: the saved sync settings could not be loaded (${reason}). Re-enter them below.`,
      })
    } catch {
      // Storage itself is unusable; the warning above is all we can do.
    }
  }
}

export function getSettingsRepository(): SettingsRepository {
  if (!settingsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return settingsRepository
}

export function getTagsRepository(): TagsRepository {
  if (!tagsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return tagsRepository
}

export function getTagDetailsRepository(): TagDetailsRepository {
  if (!tagDetailsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return tagDetailsRepository
}

export function getAccountsRepository(): AccountsRepository {
  if (!accountsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return accountsRepository
}

export function getExchangeRatesRepository(): ExchangeRatesRepository {
  if (!exchangeRatesRepository)
    throw new Error('Database not initialized. Call initDatabase() first.')
  return exchangeRatesRepository
}

export function getAppliedRatesRepository(): AppliedRatesRepository {
  if (!appliedRatesRepository)
    throw new Error('Database not initialized. Call initDatabase() first.')
  return appliedRatesRepository
}

export function getAccountGroupingsRepository(): AccountGroupingsRepository {
  if (!accountGroupingsRepository)
    throw new Error('Database not initialized. Call initDatabase() first.')
  return accountGroupingsRepository
}

export function getTransactionsRepository(): TransactionsRepository {
  if (!transactionsRepository)
    throw new Error('Database not initialized. Call initDatabase() first.')
  return transactionsRepository
}

/** Resolves and refreshes exchange rates (see src/money/rateService.ts). */
export function getRateService(): RateService {
  if (!rateService) throw new Error('Database not initialized. Call initDatabase() first.')
  return rateService
}

/** Closes the database and resets module-level singletons. Useful for testing. */
export async function closeDatabase(): Promise<void> {
  if (database) {
    await database.close()
  }
  database = null
  syncBackend.value = null
  settingsRepository = null
  tagsRepository = null
  tagDetailsRepository = null
  accountsRepository = null
  exchangeRatesRepository = null
  appliedRatesRepository = null
  accountGroupingsRepository = null
  transactionsRepository = null
  rateService = null
}
