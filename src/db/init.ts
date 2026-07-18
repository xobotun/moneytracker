import { Database } from './Database'
import { runMigrations } from './migrations'
import { migration as settingsMigration } from './migrations/001_settings'
import { migration as domainMigration } from './migrations/002_domain_schema'
import { SettingsRepository } from './repositories/SettingsRepository'
import { TagsRepository } from './repositories/TagsRepository'
import { LocationsRepository } from './repositories/LocationsRepository'
import { AccountsRepository } from './repositories/AccountsRepository'
import { ExchangeRatesRepository } from './repositories/ExchangeRatesRepository'
import { AccountGroupingsRepository } from './repositories/AccountGroupingsRepository'
import { TransactionsRepository } from './repositories/TransactionsRepository'
import type { SyncBackend } from '../sync/SyncBackend'
import { buildBackend } from '../sync/backendFactory'
import { loadProviderConfig } from '../sync/localState'

const allMigrations = [settingsMigration, domainMigration]

let database: Database | null = null
let syncBackend: SyncBackend | null = null
let settingsRepository: SettingsRepository | null = null
let tagsRepository: TagsRepository | null = null
let locationsRepository: LocationsRepository | null = null
let accountsRepository: AccountsRepository | null = null
let exchangeRatesRepository: ExchangeRatesRepository | null = null
let accountGroupingsRepository: AccountGroupingsRepository | null = null
let transactionsRepository: TransactionsRepository | null = null

export async function initDatabase(): Promise<void> {
  database = new Database()
  await database.init({ filePath: 'moneytracker.db', persist: true })
  await runMigrations(database, allMigrations)
  settingsRepository = new SettingsRepository(database)
  tagsRepository = new TagsRepository(database)
  locationsRepository = new LocationsRepository(database)
  accountsRepository = new AccountsRepository(database)
  exchangeRatesRepository = new ExchangeRatesRepository(database)
  accountGroupingsRepository = new AccountGroupingsRepository(database)
  transactionsRepository = new TransactionsRepository(database)

  // Build the sync backend from the stored provider config. null when the
  // user has not configured a provider; Settings.vue's "Sync now" button
  // disables itself in that case.
  const cfg = loadProviderConfig()
  setSyncBackend(buildBackend(cfg))
}

export function getDatabase(): Database {
  if (!database) throw new Error('Database not initialized. Call initDatabase() first.')
  return database
}

/**
 * Registers the backend used to sync the local database with the remote.
 * Called by the External-sync plan once a real backend is wired in. Until then
 * `getSyncBackend()` returns null and consumers must handle that.
 */
export function setSyncBackend(backend: SyncBackend | null): void {
  syncBackend = backend
}

/** Returns the registered backend, or null when none has been registered yet. */
export function getSyncBackend(): SyncBackend | null {
  return syncBackend
}

export function getSettingsRepository(): SettingsRepository {
  if (!settingsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return settingsRepository
}

export function getTagsRepository(): TagsRepository {
  if (!tagsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return tagsRepository
}

export function getLocationsRepository(): LocationsRepository {
  if (!locationsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return locationsRepository
}

export function getAccountsRepository(): AccountsRepository {
  if (!accountsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return accountsRepository
}

export function getExchangeRatesRepository(): ExchangeRatesRepository {
  if (!exchangeRatesRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return exchangeRatesRepository
}

export function getAccountGroupingsRepository(): AccountGroupingsRepository {
  if (!accountGroupingsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return accountGroupingsRepository
}

export function getTransactionsRepository(): TransactionsRepository {
  if (!transactionsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return transactionsRepository
}

/** Closes the database and resets module-level singletons. Useful for testing. */
export async function closeDatabase(): Promise<void> {
  if (database) {
    await database.close()
  }
  database = null
  syncBackend = null
  settingsRepository = null
  tagsRepository = null
  locationsRepository = null
  accountsRepository = null
  exchangeRatesRepository = null
  accountGroupingsRepository = null
  transactionsRepository = null
}
