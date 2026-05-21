import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { TagsRepository } from '../TagsRepository'

describe('TagsRepository', () => {
  let db: Database
  let repo: TagsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    repo = new TagsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates and finds a tag', async () => {
    await repo.create({ tag: 'wildberries', description: null, synonyms: ['wb'], colour: '#000', icon: 'cart' })
    const found = await repo.findByName('wildberries')
    expect(found?.synonyms).toEqual(['wb'])
  })

  it('returns null for a missing tag', async () => {
    expect(await repo.findByName('nope')).toBeNull()
  })

  it('updates an existing tag and bumps updated_at_utc', async () => {
    await repo.create({ tag: 'food', synonyms: [], colour: '#FF0', icon: 'cup' })
    const before = (await repo.findByName('food'))!
    await new Promise((r) => setTimeout(r, 5))
    await repo.update('food', { colour: '#0F0' })
    const after = (await repo.findByName('food'))!
    expect(after.colour).toBe('#0F0')
    expect(after.updated_at_utc > before.updated_at_utc).toBe(true)
  })

  it('soft-deletes a tag', async () => {
    await repo.create({ tag: 'temp', synonyms: [], colour: '#FFF', icon: 'x' })
    await repo.softDelete('temp')
    expect(await repo.findByName('temp')).toBeNull()
    const all = await repo.list()
    expect(all).toHaveLength(0)
  })

  it('list() returns only non-deleted', async () => {
    await repo.create({ tag: 'a', synonyms: [], colour: '#000', icon: 'x' })
    await repo.create({ tag: 'b', synonyms: [], colour: '#000', icon: 'x' })
    await repo.softDelete('a')
    const list = await repo.list()
    expect(list.map((t) => t.tag)).toEqual(['b'])
  })
})
