import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { DuplicateTagNameError, TagKindMismatchError, TagLoopError } from '../../errors'
import { asShortId, type ShortId } from '../../shortId'
import type { TagKind } from '../../types'
import { TagsRepository } from '../TagsRepository'

const AT = '2026-10-01T00:00:00.000Z'

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

  /** Inserts a row the way a sync would: no repository rules. */
  async function insertRaw(row: {
    id: string
    kind: TagKind
    name: string
    parent?: string | null
    synonyms?: string[]
    deleted?: string | null
    mergedInto?: string | null
  }): Promise<ShortId> {
    await db.run(
      `INSERT INTO tags (id, kind, name, parent_id, synonyms, merged_into_id,
                         created_at_utc, updated_at_utc, deleted_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.kind,
        row.name,
        row.parent ?? null,
        JSON.stringify(row.synonyms ?? []),
        row.mergedInto ?? null,
        AT,
        AT,
        row.deleted ?? null,
      ],
    )
    return asShortId(row.id)
  }

  it('creates a child of the same kind', async () => {
    const food = await repo.create({
      kind: 'category',
      name: 'Food',
      colour: '#22c55e',
      icon: 'tag',
    })
    const groceries = await repo.create({
      kind: 'category',
      name: 'Groceries',
      parent_id: food.id,
      synonyms: ['Supermarket'],
    })

    expect(food.id).toMatch(/^[0-9A-Za-z]{12}$/)
    expect(groceries).toMatchObject({
      kind: 'category',
      name: 'Groceries',
      parent_id: food.id,
      description: null,
      synonyms: ['Supermarket'],
      colour: null,
      icon: null,
      merged_into_id: null,
      deleted_at_utc: null,
    })
    expect(groceries.created_at_utc).toBeInstanceOf(Date)
    expect(await repo.findById(groceries.id)).toEqual(groceries)
  })

  it('refuses a parent of another kind', async () => {
    const food = await repo.create({ kind: 'category', name: 'Food' })
    await expect(
      repo.create({ kind: 'merchant', name: 'Rewe', parent_id: food.id }),
    ).rejects.toThrow(TagKindMismatchError)

    const rewe = await repo.create({ kind: 'merchant', name: 'Rewe' })
    await expect(repo.move(rewe.id, food.id)).rejects.toThrow(TagKindMismatchError)
    expect((await repo.findById(rewe.id))!.parent_id).toBeNull()
  })

  it('refuses a parent that is missing or deleted', async () => {
    const old = await repo.create({ kind: 'tag', name: 'old' })
    await repo.softDelete(old.id)
    await expect(repo.create({ kind: 'tag', name: 'x', parent_id: old.id })).rejects.toThrow(
      /not found/,
    )
    await expect(
      repo.create({ kind: 'tag', name: 'x', parent_id: asShortId('nowhere00000') }),
    ).rejects.toThrow(/not found/)
  })

  it('refuses a duplicate name among live siblings, synonyms included, ignoring case', async () => {
    await repo.create({ kind: 'merchant', name: 'Wildberries', synonyms: ['WB'] })
    await repo.create({ kind: 'category', name: 'Еда' })

    for (const input of [
      { kind: 'merchant' as const, name: 'wildberries' },
      { kind: 'merchant' as const, name: 'wb' },
      { kind: 'merchant' as const, name: 'Ozon', synonyms: ['Wb'] },
      // Non-ASCII too: SQLite's lower() would miss this one.
      { kind: 'category' as const, name: 'ЕДА' },
    ]) {
      await expect(repo.create(input), input.name).rejects.toThrow(DuplicateTagNameError)
    }
    expect(await repo.list()).toHaveLength(2)
  })

  it('checks names on update and move too, but not against deleted tags', async () => {
    const food = await repo.create({ kind: 'category', name: 'Food' })
    await repo.create({ kind: 'category', name: 'Groceries', parent_id: food.id })
    const snacks = await repo.create({ kind: 'category', name: 'Snacks', parent_id: food.id })
    const groceriesTop = await repo.create({ kind: 'category', name: 'Groceries' })

    await expect(repo.update(snacks.id, { name: 'GROCERIES' })).rejects.toThrow(
      DuplicateTagNameError,
    )
    await expect(repo.update(snacks.id, { synonyms: ['groceries'] })).rejects.toThrow(
      DuplicateTagNameError,
    )
    await expect(repo.move(groceriesTop.id, food.id)).rejects.toThrow(DuplicateTagNameError)
    expect((await repo.findById(snacks.id))!.name).toBe('Snacks')

    await repo.softDelete(snacks.id)
    await repo.create({ kind: 'category', name: 'snacks', parent_id: food.id })
  })

  it('allows the same name in another kind or under another parent', async () => {
    const germany = await repo.create({ kind: 'location', name: 'Germany' })
    const usa = await repo.create({ kind: 'location', name: 'USA' })
    await repo.create({ kind: 'location', name: 'Berlin', parent_id: germany.id })
    await repo.create({ kind: 'location', name: 'Berlin', parent_id: usa.id })
    await repo.create({ kind: 'journey', name: 'Berlin' })

    expect((await repo.list()).filter((t) => t.name === 'Berlin')).toHaveLength(3)
  })

  it('refuses to move a tag under its own descendant', async () => {
    const x = await repo.create({ kind: 'category', name: 'X' })
    const a = await repo.create({ kind: 'category', name: 'A', parent_id: x.id })
    const y = await repo.create({ kind: 'category', name: 'Y', parent_id: a.id })

    const error = await repo.move(x.id, y.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TagLoopError)
    expect((error as TagLoopError).path).toEqual(['X', 'A', 'Y'])
    expect((error as TagLoopError).message).toContain('X > A > Y')

    const self = await repo.move(x.id, x.id).catch((e: unknown) => e)
    expect((self as TagLoopError).path).toEqual(['X'])
    expect((await repo.findById(x.id))!.parent_id).toBeNull()
  })

  it('moves a tag to another parent and back to the top level', async () => {
    const food = await repo.create({ kind: 'category', name: 'Food' })
    const fun = await repo.create({ kind: 'category', name: 'Fun' })
    const snacks = await repo.create({ kind: 'category', name: 'Snacks', parent_id: food.id })

    await repo.move(snacks.id, fun.id)
    expect((await repo.findById(snacks.id))!.parent_id).toBe(fun.id)
    await repo.move(snacks.id, null)
    expect((await repo.findById(snacks.id))!.parent_id).toBeNull()
  })

  it('rename keeps the id', async () => {
    const tag = await repo.create({ kind: 'tag', name: 'birthday' })
    await new Promise((r) => setTimeout(r, 5))
    await repo.update(tag.id, { name: 'birthdays' })

    const renamed = (await repo.findById(tag.id))!
    expect(renamed.name).toBe('birthdays')
    expect(renamed.updated_at_utc > tag.updated_at_utc).toBe(true)
    expect(await repo.findByName('tag', 'birthday')).toBeNull()
  })

  it('updates the other fields and stores an empty description as NULL', async () => {
    const tag = await repo.create({ kind: 'tag', name: 'work', description: '' })
    expect(tag.description).toBeNull()

    await repo.update(tag.id, {
      description: 'Office',
      synonyms: ['job'],
      colour: '#ef4444',
      icon: 'briefcase',
    })
    expect(await repo.findById(tag.id)).toMatchObject({
      description: 'Office',
      synonyms: ['job'],
      colour: '#ef4444',
      icon: 'briefcase',
    })

    await repo.update(tag.id, { description: '', colour: null, icon: null })
    expect(await repo.findById(tag.id)).toMatchObject({
      description: null,
      colour: null,
      icon: null,
    })
  })

  it('softDelete moves children up to the deleted tag’s parent', async () => {
    const food = await repo.create({ kind: 'category', name: 'Food' })
    const groceries = await repo.create({ kind: 'category', name: 'Groceries', parent_id: food.id })
    const organic = await repo.create({
      kind: 'category',
      name: 'Organic',
      parent_id: groceries.id,
    })
    const fruit = await repo.create({ kind: 'category', name: 'Fruit', parent_id: groceries.id })

    await repo.softDelete(groceries.id)

    expect(await repo.findById(groceries.id)).toBeNull()
    expect((await repo.findById(organic.id))!.parent_id).toBe(food.id)
    expect((await repo.findById(fruit.id))!.parent_id).toBe(food.id)
    expect((await repo.findById(food.id))!.parent_id).toBeNull()

    // A top-level tag's children become top-level.
    await repo.softDelete(food.id)
    expect((await repo.findById(organic.id))!.parent_id).toBeNull()
  })

  it('restore puts a tag whose parent is deleted at the top level', async () => {
    const food = await repo.create({ kind: 'category', name: 'Food' })
    const groceries = await repo.create({ kind: 'category', name: 'Groceries', parent_id: food.id })
    const snacks = await repo.create({ kind: 'category', name: 'Snacks', parent_id: food.id })
    await repo.softDelete(groceries.id)
    await repo.softDelete(snacks.id)

    await repo.restore(snacks.id)
    expect(await repo.findById(snacks.id)).toMatchObject({
      parent_id: food.id,
      deleted_at_utc: null,
    })

    await repo.softDelete(food.id)
    await repo.restore(groceries.id)
    expect(await repo.findById(groceries.id)).toMatchObject({
      parent_id: null,
      deleted_at_utc: null,
    })
  })

  it('restore refuses a merged tag', async () => {
    const target = await insertRaw({ id: 'target000001', kind: 'merchant', name: 'Wildberries' })
    const merged = await insertRaw({
      id: 'merged000001',
      kind: 'merchant',
      name: 'WB',
      deleted: AT,
      mergedInto: target,
    })

    await expect(repo.restore(merged)).rejects.toThrow(/merged/)
    expect(await repo.findById(merged)).toBeNull()
  })

  it('finds by synonym ignoring case', async () => {
    const wildberries = await repo.create({
      kind: 'merchant',
      name: 'Wildberries',
      synonyms: ['WB', 'Вайлдберриз'],
    })

    expect((await repo.findByName('merchant', 'wb'))!.id).toBe(wildberries.id)
    expect((await repo.findByName('merchant', 'ВАЙЛДБЕРРИЗ'))!.id).toBe(wildberries.id)
    expect((await repo.findByName('merchant', 'wildberries', null))!.id).toBe(wildberries.id)
    expect(await repo.findByName('category', 'wb')).toBeNull()
  })

  it('findByName looks under the given parent only, and at live tags only', async () => {
    const germany = await repo.create({ kind: 'location', name: 'Germany' })
    const berlin = await repo.create({ kind: 'location', name: 'Berlin', parent_id: germany.id })

    expect((await repo.findByName('location', 'berlin'))!.id).toBe(berlin.id)
    expect((await repo.findByName('location', 'berlin', germany.id))!.id).toBe(berlin.id)
    expect(await repo.findByName('location', 'berlin', null)).toBeNull()

    await repo.softDelete(berlin.id)
    expect(await repo.findByName('location', 'berlin')).toBeNull()
  })

  it('lists live tags by name, optionally of one kind; listAll includes deleted and merged', async () => {
    await repo.create({ kind: 'tag', name: 'zoo' })
    await repo.create({ kind: 'tag', name: 'art' })
    const gone = await repo.create({ kind: 'tag', name: 'gone' })
    await repo.create({ kind: 'merchant', name: 'Lidl' })
    await repo.softDelete(gone.id)
    const target = await repo.create({ kind: 'merchant', name: 'Rewe' })
    await insertRaw({
      id: 'merged000001',
      kind: 'merchant',
      name: 'REWE Markt',
      deleted: AT,
      mergedInto: target.id,
    })

    expect((await repo.list('tag')).map((t) => t.name)).toEqual(['art', 'zoo'])
    expect((await repo.list()).map((t) => t.name)).toEqual(['Lidl', 'Rewe', 'art', 'zoo'])
    const all = await repo.listAll()
    expect(all.map((t) => t.name).sort()).toEqual(
      ['Lidl', 'REWE Markt', 'Rewe', 'art', 'gone', 'zoo'].sort(),
    )
    expect(all.find((t) => t.name === 'REWE Markt')!.merged_into_id).toBe(target.id)
  })

  it('lists duplicates inserted by sync', async () => {
    const group = await insertRaw({ id: 'group0000001', kind: 'merchant', name: 'Retail' })
    const a = await insertRaw({ id: 'rewe00000001', kind: 'merchant', name: 'Rewe' })
    const b = await insertRaw({ id: 'rewe00000002', kind: 'merchant', name: 'rewe' })
    const c = await insertRaw({
      id: 'rewe00000003',
      kind: 'merchant',
      name: 'REWE Markt',
      synonyms: ['REWE'],
    })
    const aldi1 = await insertRaw({ id: 'aldi00000001', kind: 'merchant', name: 'Aldi' })
    const aldi2 = await insertRaw({ id: 'aldi00000002', kind: 'merchant', name: 'ALDI' })
    // Not duplicates: another kind, another parent, a deleted row.
    await insertRaw({ id: 'rewe00000004', kind: 'location', name: 'Rewe' })
    await insertRaw({ id: 'rewe00000005', kind: 'merchant', name: 'Rewe', parent: group })
    await insertRaw({ id: 'lidl00000001', kind: 'merchant', name: 'Lidl' })
    await insertRaw({ id: 'lidl00000002', kind: 'merchant', name: 'Lidl', deleted: AT })

    const groups = (await repo.duplicates()).map((g) => [...g].sort())
    expect(groups.sort((x, y) => x[0]!.localeCompare(y[0]!))).toEqual([
      [aldi1, aldi2],
      [a, b, c],
    ])
  })
})
