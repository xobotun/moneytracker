import type { Database } from '../Database'
import type { SettingsKey } from '../SettingsKey'

export class SettingsRepository {
  constructor(private db: Database) {}

  async get<T>(key: SettingsKey<T>): Promise<T | null> {
    const rows = await this.db.exec<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [key.key],
    )
    if (rows.length === 0) return null
    return JSON.parse(rows[0]!.value) as T
  }

  async set<T>(key: SettingsKey<T>, value: T): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO settings (key, value, updated_at_utc) VALUES (?, ?, ?)',
      [key.key, JSON.stringify(value), new Date().toISOString()],
    )
  }

  async delete<T>(key: SettingsKey<T>): Promise<void> {
    await this.db.run('DELETE FROM settings WHERE key = ?', [key.key])
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.db.exec<{ key: string; value: string }>(
      'SELECT key, value FROM settings',
    )
    const result: Record<string, unknown> = {}
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value)
    }
    return result
  }
}
