import { Database } from './Database'
import { runMigrations } from './migrations'
import { migration as settingsMigration } from './migrations/001_settings'
import { SettingsRepository } from './repositories/SettingsRepository'

const allMigrations = [settingsMigration]

let database: Database | null = null
let settingsRepository: SettingsRepository | null = null

export async function initDatabase(): Promise<void> {
  database = new Database()
  await database.init({ filePath: 'moneytracker.db', useOPFS: true })
  await runMigrations(database, allMigrations)
  settingsRepository = new SettingsRepository(database)
}

export function getDatabase(): Database {
  if (!database) throw new Error('Database not initialized. Call initDatabase() first.')
  return database
}

export function getSettingsRepository(): SettingsRepository {
  if (!settingsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return settingsRepository
}
