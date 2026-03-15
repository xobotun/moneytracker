import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { SettingsRepository } from '../SettingsRepository'
import { settingsKey } from '../../SettingsKey'

const THEME = settingsKey<string>('theme')
const FONT_SIZE = settingsKey<number>('fontSize')
const ENABLED = settingsKey<boolean>('enabled')
const COMPLEX = settingsKey<{ a: number; b: string }>('complex')
const KEY = settingsKey<string>('key')
const A = settingsKey<number>('a')
const B = settingsKey<string>('b')

describe('SettingsRepository', () => {
  let db: Database
  let repo: SettingsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration])
    repo = new SettingsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('returns null for a missing key', async () => {
    expect(await repo.get(settingsKey('nonexistent'))).toBeNull()
  })

  it('stores and retrieves a string value', async () => {
    await repo.set(THEME, 'dark')
    expect(await repo.get(THEME)).toBe('dark')
  })

  it('stores and retrieves a number value', async () => {
    await repo.set(FONT_SIZE, 14)
    expect(await repo.get(FONT_SIZE)).toBe(14)
  })

  it('stores and retrieves a boolean value', async () => {
    await repo.set(ENABLED, true)
    expect(await repo.get(ENABLED)).toBe(true)
  })

  it('stores and retrieves an object value', async () => {
    const obj = { a: 1, b: 'two' }
    await repo.set(COMPLEX, obj)
    expect(await repo.get(COMPLEX)).toEqual(obj)
  })

  it('overwrites an existing key', async () => {
    await repo.set(KEY, 'first')
    await repo.set(KEY, 'second')
    expect(await repo.get(KEY)).toBe('second')
  })

  it('deletes a key', async () => {
    await repo.set(KEY, 'value')
    await repo.delete(KEY)
    expect(await repo.get(KEY)).toBeNull()
  })

  it('getAll() returns all settings as a record', async () => {
    await repo.set(A, 1)
    await repo.set(B, 'two')
    const all = await repo.getAll()
    expect(all).toEqual({ a: 1, b: 'two' })
  })

  it('getAll() returns empty record when no settings exist', async () => {
    expect(await repo.getAll()).toEqual({})
  })
})
