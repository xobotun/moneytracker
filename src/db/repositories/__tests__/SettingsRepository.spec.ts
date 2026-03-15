import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { SettingsRepository } from '../SettingsRepository'

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
    expect(await repo.get('nonexistent')).toBeNull()
  })

  it('stores and retrieves a string value', async () => {
    await repo.set('theme', 'dark')
    expect(await repo.get<string>('theme')).toBe('dark')
  })

  it('stores and retrieves a number value', async () => {
    await repo.set('fontSize', 14)
    expect(await repo.get<number>('fontSize')).toBe(14)
  })

  it('stores and retrieves a boolean value', async () => {
    await repo.set('enabled', true)
    expect(await repo.get<boolean>('enabled')).toBe(true)
  })

  it('stores and retrieves an object value', async () => {
    const obj = { a: 1, b: 'two' }
    await repo.set('complex', obj)
    expect(await repo.get('complex')).toEqual(obj)
  })

  it('overwrites an existing key', async () => {
    await repo.set('key', 'first')
    await repo.set('key', 'second')
    expect(await repo.get<string>('key')).toBe('second')
  })

  it('deletes a key', async () => {
    await repo.set('key', 'value')
    await repo.delete('key')
    expect(await repo.get('key')).toBeNull()
  })

  it('getAll() returns all settings as a record', async () => {
    await repo.set('a', 1)
    await repo.set('b', 'two')
    const all = await repo.getAll()
    expect(all).toEqual({ a: 1, b: 'two' })
  })

  it('getAll() returns empty record when no settings exist', async () => {
    expect(await repo.getAll()).toEqual({})
  })
})
