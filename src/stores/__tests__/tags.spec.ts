import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { setActivePinia, createPinia } from 'pinia'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { TagsRepository, type TagSaveInput } from '@/db/repositories/TagsRepository'
import { TagDetailsRepository, noDetails } from '@/db/repositories/TagDetailsRepository'
import { DuplicateTagNameError } from '@/db/errors'
import type { Tag } from '@/db/types'
import { useTagsStore } from '../tags'

let tagsRepo: TagsRepository
let detailsRepo: TagDetailsRepository
vi.mock('@/db/init', () => ({
  getTagsRepository: () => tagsRepo,
  getTagDetailsRepository: () => detailsRepo,
}))

/** The input that saves `tag` as it is, with `over` applied. */
function saveInput(tag: Tag, over: Partial<TagSaveInput> = {}): TagSaveInput {
  return {
    name: tag.name,
    parent_id: tag.parent_id,
    description: tag.description,
    otherNames: tag.synonyms,
    colour: tag.colour,
    icon: tag.icon,
    details: noDetails(),
    ...over,
  }
}

describe('useTagsStore', () => {
  let db: Database

  beforeEach(async () => {
    setActivePinia(createPinia())
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    tagsRepo = new TagsRepository(db)
    detailsRepo = new TagDetailsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('reuses an archived plain tag typed by name rather than creating another', async () => {
    const store = useTagsStore()
    const [daily] = await store.resolvePlainTags(['daily'])
    await tagsRepo.archive(daily!)
    expect(await store.resolvePlainTags(['Daily'])).toEqual([daily])
    expect(await tagsRepo.listAll()).toHaveLength(1)
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
    expect(all[0]!.icon).toEqual(primeIcon('hashtag'))
  })

  it('finds an existing tag by synonym, ignoring case', async () => {
    const store = useTagsStore()
    const tag = await tagsRepo.create({ kind: 'tag', name: 'Holiday', synonyms: ['vacation'] })
    expect(await store.resolvePlainTags(['VACATION', 'holiday'])).toEqual([tag.id])
    expect(await tagsRepo.listAll()).toHaveLength(1)
  })

  it('keeps a nested tag the account already has', async () => {
    const store = useTagsStore()
    const family = await tagsRepo.create({ kind: 'tag', name: 'family' })
    const mia = await tagsRepo.create({ kind: 'tag', name: 'mia', parent_id: family.id })
    expect(await store.resolvePlainTags(['Mia'], [mia.id])).toEqual([mia.id])
    expect(await tagsRepo.listAll()).toHaveLength(2)
  })

  it('finds a nested tag by a typed name', async () => {
    const store = useTagsStore()
    const family = await tagsRepo.create({ kind: 'tag', name: 'family' })
    const mia = await tagsRepo.create({ kind: 'tag', name: 'mia', parent_id: family.id })
    expect(await store.resolvePlainTags(['mia'])).toEqual([mia.id])
  })

  it("prefers the account's own tag over an older namesake elsewhere", async () => {
    const store = useTagsStore()
    // Clearly older, so a lookup by name alone would pick it.
    const at = '2020-01-01T00:00:00.000Z'
    await db.run(
      `INSERT INTO tags (id, kind, name, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES ('miaTop000001', 'tag', 'mia', ?, ?, ?)`,
      [at, at, at],
    )
    expect((await tagsRepo.findByName('tag', 'mia'))?.id).toBe('miaTop000001')
    const family = await tagsRepo.create({ kind: 'tag', name: 'family' })
    const nested = await tagsRepo.create({ kind: 'tag', name: 'mia', parent_id: family.id })
    expect(await store.resolvePlainTags(['mia'], [nested.id])).toEqual([nested.id])
  })

  it("keeps a known tag by its name before another's synonym", async () => {
    const store = useTagsStore()
    const work = await tagsRepo.create({ kind: 'tag', name: 'work', synonyms: ['job'] })
    const projects = await tagsRepo.create({ kind: 'tag', name: 'projects' })
    const job = await tagsRepo.create({ kind: 'tag', name: 'job', parent_id: projects.id })
    expect(await store.resolvePlainTags(['work', 'job'], [work.id, job.id])).toEqual([
      work.id,
      job.id,
    ])
  })

  it('keeps every known tag that a chip names', async () => {
    // Two tags called mia at different levels show as one chip; both stay.
    const store = useTagsStore()
    const mia = await tagsRepo.create({ kind: 'tag', name: 'mia' })
    const family = await tagsRepo.create({ kind: 'tag', name: 'family' })
    const nested = await tagsRepo.create({ kind: 'tag', name: 'mia', parent_id: family.id })
    expect(await store.resolvePlainTags(['mia'], [mia.id, nested.id])).toEqual([mia.id, nested.id])
  })

  describe('write-through actions', () => {
    it('create persists and reloads', async () => {
      const store = useTagsStore()
      const food = await store.create({ kind: 'category', name: 'Food' })
      expect(store.loaded).toBe(true)
      expect(store.byId.get(food.id)?.name).toBe('Food')
    })

    it('save reloads the renamed tag', async () => {
      const store = useTagsStore()
      const food = await store.create({ kind: 'category', name: 'Food' })
      await store.save(food.id, saveInput(food, { name: 'Groceries' }))
      expect(store.nameOf(food.id)).toBe('Groceries')
    })

    it('merge reloads both tags', async () => {
      const store = useTagsStore()
      const lunch = await store.create({ kind: 'category', name: 'Lunch' })
      const food = await store.create({ kind: 'category', name: 'Food' })
      await store.merge(lunch.id, food.id)
      expect(store.byId.get(lunch.id)).toMatchObject({ merged_into_id: food.id })
      expect(store.byId.get(food.id)?.synonyms).toEqual(['Lunch'])
    })

    it('remove and restore', async () => {
      const store = useTagsStore()
      const food = await store.create({ kind: 'category', name: 'Food' })
      await store.remove(food.id)
      expect(store.byId.get(food.id)?.deleted_at_utc).not.toBeNull()
      await store.restore(food.id)
      expect(store.byId.get(food.id)?.deleted_at_utc).toBeNull()
    })

    it('archive and unarchive', async () => {
      const store = useTagsStore()
      const rewe = await store.create({ kind: 'merchant', name: 'Rewe' })
      await store.archive(rewe.id)
      expect(store.byId.get(rewe.id)?.archived_at_utc).not.toBeNull()
      expect((await tagsRepo.findById(rewe.id))!.archived_at_utc).not.toBeNull()
      await store.unarchive(rewe.id)
      expect(store.byId.get(rewe.id)?.archived_at_utc).toBeNull()
    })

    it('a failed archive rethrows and leaves the tags as they were', async () => {
      const store = useTagsStore()
      const rewe = await store.create({ kind: 'merchant', name: 'Rewe' })
      await tagsRepo.softDelete(rewe.id) // behind the store's back
      await expect(store.archive(rewe.id)).rejects.toThrow(/deleted/)
      expect(store.byId.get(rewe.id)).toMatchObject({ archived_at_utc: null, deleted_at_utc: null })
    })

    it('load reads what merchants and locations link to, and a save updates it', async () => {
      const store = useTagsStore()
      const food = await store.create({ kind: 'category', name: 'Food' })
      const rewe = await store.create({
        kind: 'merchant',
        name: 'Rewe',
        details: { ...noDetails(), default_category_id: food.id },
      })
      expect(store.detailLinks.get(rewe.id)).toBe(food.id)
      await store.save(rewe.id, saveInput(rewe))
      expect(store.detailLinks.has(rewe.id)).toBe(false)
    })

    it('load collects duplicate ids', async () => {
      const store = useTagsStore()
      const at = '2026-10-01T00:00:00.000Z'
      for (const id of ['reweA0000001', 'reweB0000001']) {
        await db.run(
          `INSERT INTO tags (id, kind, name, moved_at_utc, created_at_utc, updated_at_utc)
           VALUES (?, 'merchant', 'Rewe', ?, ?, ?)`,
          [id, at, at, at],
        )
      }
      await store.create({ kind: 'merchant', name: 'Edeka' })
      expect([...store.duplicateIds].sort()).toEqual(['reweA0000001', 'reweB0000001'])
    })

    it('a failed save rethrows and leaves the tags as they were', async () => {
      const store = useTagsStore()
      const food = await store.create({ kind: 'category', name: 'Food' })
      await store.create({ kind: 'category', name: 'Drinks' })
      const before = store.tags
      await expect(store.save(food.id, saveInput(food, { name: 'drinks' }))).rejects.toThrow(
        DuplicateTagNameError,
      )
      expect(store.tags).toBe(before)
    })

    it('reads usage, details and journey dates', async () => {
      const store = useTagsStore()
      const rome = await store.create({
        kind: 'journey',
        name: 'Rome',
        details: { ...noDetails(), start_date: '2026-05-01' },
      })
      expect(await store.usageCount(rome.id)).toBe(0)
      expect(await store.details(rome)).toMatchObject({ start_date: '2026-05-01' })
      expect(await store.journeyDates(rome.id)).toMatchObject({
        start: '2026-05-01',
        startTyped: true,
        end: null,
      })
      // Every journey's dates are held, read again with the tags.
      expect(store.journeyDatesById.get(rome.id)).toMatchObject({ start: '2026-05-01' })
      await store.save(rome.id, {
        ...saveInput(rome),
        details: { ...noDetails(), start_date: '2026-06-01' },
      })
      expect(store.journeyDatesById.get(rome.id)).toMatchObject({ start: '2026-06-01' })
    })
  })

  it('does not match tags of another kind', async () => {
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
