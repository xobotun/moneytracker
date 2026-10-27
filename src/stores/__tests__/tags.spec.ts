import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { TagsRepository } from '@/db/repositories/TagsRepository'
import { useTagsStore } from '../tags'

let tagsRepo: TagsRepository
vi.mock('@/db/init', () => ({
  getTagsRepository: () => tagsRepo,
}))

describe('useTagsStore', () => {
  let db: Database

  beforeEach(async () => {
    setActivePinia(createPinia())
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    tagsRepo = new TagsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates a missing plain tag once and reuses it', async () => {
    const store = useTagsStore()
    const [first] = await store.resolvePlainTags(['daily'])
    const [again] = await store.resolvePlainTags(['daily'])
    expect(again).toBe(first)
    const all = await tagsRepo.listAll()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ kind: 'tag', name: 'daily', parent_id: null })
    expect(all[0]!.colour).not.toBeNull()
    expect(all[0]!.icon).toBe('hashtag')
  })

  it('finds an existing tag by synonym, ignoring case', async () => {
    const store = useTagsStore()
    const tag = await tagsRepo.create({ kind: 'tag', name: 'Holiday', synonyms: ['vacation'] })
    expect(await store.resolvePlainTags(['VACATION', 'holiday'])).toEqual([tag.id])
    expect(await tagsRepo.listAll()).toHaveLength(1)
  })

  it('does not match tags of another kind or below a parent', async () => {
    const store = useTagsStore()
    await tagsRepo.create({ kind: 'category', name: 'food' })
    const [id] = await store.resolvePlainTags(['food'])
    const food = (await tagsRepo.listAll()).find((t) => t.id === id)!
    expect(food.kind).toBe('tag')
  })

  it('trims, skips empty names, keeps first-occurrence order and drops duplicate ids', async () => {
    const store = useTagsStore()
    const ids = await store.resolvePlainTags([' b ', '', 'a', 'b', '  '])
    expect(ids).toHaveLength(2)
    expect(ids.map((id) => store.nameOf(id))).toEqual(['b', 'a'])
  })

  it('names a tag by id after load, and renames follow a reload', async () => {
    const store = useTagsStore()
    const [id] = await store.resolvePlainTags(['old'])
    await tagsRepo.update(id!, { name: 'new' })
    await store.load()
    expect(store.nameOf(id!)).toBe('new')
    expect(store.byId.get(id!)?.name).toBe('new')
  })
})
