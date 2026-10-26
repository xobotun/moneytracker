import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import {
  CategoryInUseError,
  DuplicateTagNameError,
  MergeConflictError,
  TagKindMismatchError,
  TagLoopError,
} from '../../errors'
import { asShortId, type ShortId } from '../../shortId'
import type { TagKind } from '../../types'
import { localMoment } from '../../LocalMoment'
import { moneyAmount, zeroMoney } from '../../MoneyAmount'
import { AccountsRepository } from '../AccountsRepository'
import { TransactionsRepository } from '../TransactionsRepository'
import { TagsRepository } from '../TagsRepository'
import { TagDetailsRepository } from '../TagDetailsRepository'

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

  function wallet(tags: ShortId[] = []) {
    return new AccountsRepository(db).create({
      name: 'Wallet',
      balance: zeroMoney('EUR'),
      tags,
      location_id: null,
      grouping_id: null,
      colour: '#000000',
      icon: 'wallet',
    })
  }

  /** A 5 € expense from `from`, wholly in `category`. */
  function spend(
    from: ShortId,
    category: ShortId,
    refs: { tags?: ShortId[]; merchant_id?: ShortId } = {},
  ) {
    const eur = moneyAmount(500, 2, 'EUR')
    return new TransactionsRepository(db).create({
      account_id__from: from,
      account_id__to: null,
      amount__from: eur,
      amount__to: eur,
      transaction_at: localMoment('2026-10-25T12:00:00.000+02:00', 'Europe/Berlin'),
      date_override: null,
      tags: refs.tags ?? [],
      categories: [{ category_id: category, amount__from: eur, amount__to: eur }],
      merchant_id: refs.merchant_id ?? null,
      location_lat: null,
      location_lon: null,
      location_id: null,
    })
  }

  it('merges a tag into another: references move, the source remembers the target', async () => {
    const x = await repo.create({ kind: 'merchant', name: 'REWE Markt' })
    const y = await repo.create({
      kind: 'merchant',
      name: 'Rewe',
      description: 'Supermarket',
      colour: '#cc0000',
      icon: 'shop',
    })
    const food = await repo.create({ kind: 'category', name: 'Food' })
    const t = await spend((await wallet()).id, food.id, { merchant_id: x.id })

    await repo.merge(x.id, y.id)

    expect(await repo.findById(x.id)).toBeNull()
    const merged = (await repo.listAll()).find((tag) => tag.id === x.id)!
    expect(merged.merged_into_id).toBe(y.id)
    expect(merged.deleted_at_utc).toBeInstanceOf(Date)
    expect((await new TransactionsRepository(db).findById(t.id))!.merchant_id).toBe(y.id)
    // The target keeps its own look.
    expect(await repo.findById(y.id)).toMatchObject({
      description: 'Supermarket',
      colour: '#cc0000',
      icon: 'shop',
    })
    expect(await repo.usageCount(y.id)).toBe(1)
  })

  it("moves the source's children under the target", async () => {
    const x = await repo.create({ kind: 'category', name: 'Everyday food' })
    const y = await repo.create({ kind: 'category', name: 'Groceries' })
    const snacks = await repo.create({ kind: 'category', name: 'Snacks', parent_id: x.id })
    const milkX = await repo.create({ kind: 'category', name: 'Milk', parent_id: x.id })
    const milkY = await repo.create({ kind: 'category', name: 'Milk', parent_id: y.id })
    const old = await repo.create({ kind: 'category', name: 'Old', parent_id: x.id })
    await repo.softDelete(old.id)

    await repo.merge(x.id, y.id)

    expect((await repo.findById(snacks.id))!.parent_id).toBe(y.id)
    expect((await repo.listAll()).find((tag) => tag.id === old.id)!.parent_id).toBe(y.id)
    // A name clash among the moved children is kept, and shown as a duplicate.
    expect((await repo.findById(milkX.id))!.parent_id).toBe(y.id)
    expect(await repo.duplicates()).toEqual([[milkX.id, milkY.id].sort()])
  })

  it("adds the source's names as synonyms", async () => {
    const y = await repo.create({
      kind: 'merchant',
      name: 'Wildberries',
      synonyms: ['Wildberries RU'],
    })
    const marketplaces = await repo.create({ kind: 'merchant', name: 'Marketplaces' })
    const x = await repo.create({
      kind: 'merchant',
      name: 'WB',
      parent_id: marketplaces.id,
      synonyms: ['wb shop', 'WILDBERRIES', 'wildberries ru', 'Вайлдберриз', 'ВАЙЛДБЕРРИЗ'],
    })

    await repo.merge(x.id, y.id)

    expect((await repo.findById(y.id))!.synonyms).toEqual([
      'Wildberries RU',
      'WB',
      'wb shop',
      'Вайлдберриз',
    ])
    expect((await repo.findByName('merchant', 'wb'))!.id).toBe(y.id)

    // A duplicate from sync adds nothing new.
    const a = await insertRaw({ id: 'rewe00000001', kind: 'merchant', name: 'Rewe' })
    const b = await insertRaw({ id: 'rewe00000002', kind: 'merchant', name: 'REWE' })
    await repo.merge(b, a)
    expect(await repo.findById(a)).toMatchObject({ name: 'Rewe', synonyms: [] })
    expect(await repo.findById(a)).toMatchObject({ updated_at_utc: new Date(AT) })
  })

  it('refuses to merge a tag into its own descendant', async () => {
    const x = await repo.create({ kind: 'category', name: 'X' })
    const a = await repo.create({ kind: 'category', name: 'A', parent_id: x.id })
    const y = await repo.create({ kind: 'category', name: 'Y', parent_id: a.id })

    const error = await repo.merge(x.id, y.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TagLoopError)
    expect((error as TagLoopError).path).toEqual(['X', 'A', 'Y'])
    const self = await repo.merge(x.id, x.id).catch((e: unknown) => e)
    expect((self as TagLoopError).path).toEqual(['X'])
    expect(await repo.findById(x.id)).toMatchObject({ synonyms: [], merged_into_id: null })
    expect((await repo.findById(a.id))!.parent_id).toBe(x.id)

    // Into an ancestor is fine: the children move up to it.
    await repo.merge(a.id, x.id)
    expect((await repo.findById(y.id))!.parent_id).toBe(x.id)
  })

  it('refuses to merge across kinds', async () => {
    const food = await repo.create({ kind: 'category', name: 'Food' })
    const rewe = await repo.create({ kind: 'merchant', name: 'Rewe' })

    await expect(repo.merge(rewe.id, food.id)).rejects.toThrow(TagKindMismatchError)
    expect(await repo.findById(rewe.id)).toMatchObject({ merged_into_id: null })
    expect((await repo.findById(food.id))!.synonyms).toEqual([])

    // Both tags must be live.
    const gone = await repo.create({ kind: 'merchant', name: 'Gone' })
    await repo.softDelete(gone.id)
    await expect(repo.merge(gone.id, rewe.id)).rejects.toThrow(/not found/)
    await expect(repo.merge(rewe.id, gone.id)).rejects.toThrow(/not found/)
  })

  it('refuses to delete a category in use', async () => {
    const food = await repo.create({ kind: 'category', name: 'Food' })
    const snacks = await repo.create({ kind: 'category', name: 'Snacks', parent_id: food.id })
    const groceries = await repo.create({ kind: 'category', name: 'Groceries' })
    const work = await repo.create({ kind: 'tag', name: 'work' })
    const acc = await wallet()
    const t = await spend(acc.id, food.id)

    await expect(repo.softDelete(food.id)).rejects.toThrow(CategoryInUseError)
    expect(await repo.findById(food.id)).not.toBeNull()
    expect((await repo.findById(snacks.id))!.parent_id).toBe(food.id)

    // Other kinds can be deleted while in use; their references stay.
    const tagged = await spend(acc.id, groceries.id, { tags: [work.id] })
    await repo.softDelete(work.id)
    expect(await repo.findById(work.id)).toBeNull()
    expect((await new TransactionsRepository(db).findById(tagged.id))!.tags).toEqual([work.id])

    // Once no live transaction uses the category, it can go.
    await new TransactionsRepository(db).softDelete(t.id)
    await repo.softDelete(food.id)
    expect(await repo.findById(food.id)).toBeNull()
  })

  it('usageCount counts transactions and accounts', async () => {
    const work = await repo.create({ kind: 'tag', name: 'work' })
    const food = await repo.create({ kind: 'category', name: 'Food' })
    const unused = await repo.create({ kind: 'tag', name: 'unused' })
    const acc = await wallet([work.id])
    await spend(acc.id, food.id, { tags: [work.id] })
    const deleted = await spend(acc.id, food.id, { tags: [work.id] })
    await new TransactionsRepository(db).softDelete(deleted.id)

    expect(await repo.usageCount(work.id)).toBe(2)
    expect(await repo.usageCount(food.id)).toBe(1)
    expect(await repo.usageCount(unused.id)).toBe(0)
  })

  describe('merging details', () => {
    let details: TagDetailsRepository
    beforeEach(() => {
      details = new TagDetailsRepository(db)
    })

    async function twoLocations() {
      const a = await repo.create({ kind: 'location', name: 'REWE Mitte' })
      const b = await repo.create({ kind: 'location', name: 'REWE Markt' })
      return { a, b }
    }

    it("fills the target's empty details from the source", async () => {
      const { a, b } = await twoLocations()
      const rewe = await repo.create({ kind: 'merchant', name: 'REWE' })
      await details.setLocation(a.id, {
        address: 'Weg 1',
        latitude: 52.5,
        longitude: 13.4,
        merchant_id: rewe.id,
      })
      await repo.merge(a.id, b.id)
      expect(await details.getLocation(b.id)).toEqual({
        tag_id: b.id,
        address: 'Weg 1',
        latitude: 52.5,
        longitude: 13.4,
        merchant_id: rewe.id,
      })
    })

    it('keeps the target value when the source has none, and leaves its row alone', async () => {
      const { a, b } = await twoLocations()
      await details.setLocation(b.id, {
        address: 'Weg 2',
        latitude: null,
        longitude: null,
        merchant_id: null,
      })
      const before = await db.exec('SELECT * FROM location_details WHERE tag_id = ?', [b.id])
      await repo.merge(a.id, b.id)
      expect(await db.exec('SELECT * FROM location_details WHERE tag_id = ?', [b.id])).toEqual(
        before,
      )
    })

    it('treats equal values as no conflict', async () => {
      const { a, b } = await twoLocations()
      const same = { address: 'Weg 1', latitude: 52.5, longitude: 13.4, merchant_id: null }
      await details.setLocation(a.id, same)
      await details.setLocation(b.id, same)
      expect(await repo.detailConflicts(a.id, b.id)).toEqual([])
      await repo.merge(a.id, b.id)
      expect(await details.getLocation(b.id)).toMatchObject(same)
    })

    it('counts a half-set position as none', async () => {
      const { a, b } = await twoLocations()
      await details.setLocation(a.id, {
        address: null,
        latitude: 1,
        longitude: null,
        merchant_id: null,
      })
      await details.setLocation(b.id, {
        address: null,
        latitude: 5,
        longitude: 6,
        merchant_id: null,
      })
      expect(await repo.detailConflicts(a.id, b.id)).toEqual([])
    })

    it('refuses a conflicting merge without a resolution', async () => {
      const { a, b } = await twoLocations()
      await details.setLocation(a.id, {
        address: 'Weg 1',
        latitude: 52.5,
        longitude: 13.4,
        merchant_id: null,
      })
      await details.setLocation(b.id, {
        address: 'Weg 2',
        latitude: 48.1,
        longitude: 11.6,
        merchant_id: null,
      })
      const error = await repo.merge(a.id, b.id).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MergeConflictError)
      expect((error as MergeConflictError).conflicts.map((c) => c.field)).toEqual([
        'address',
        'position',
      ])
      expect(await repo.findById(a.id)).toMatchObject({ merged_into_id: null })
      expect(await details.getLocation(b.id)).toMatchObject({ address: 'Weg 2', latitude: 48.1 })
    })

    it('stores a resolved third value, or the source side, or null', async () => {
      const { a, b } = await twoLocations()
      await details.setLocation(a.id, {
        address: 'Weg 1',
        latitude: 52.5,
        longitude: 13.4,
        merchant_id: null,
      })
      await details.setLocation(b.id, {
        address: 'Weg 2',
        latitude: 48.1,
        longitude: 11.6,
        merchant_id: null,
      })
      await repo.merge(a.id, b.id, {
        address: 'Weg 3',
        position: { latitude: 52.5, longitude: 13.4 },
      })
      expect(await details.getLocation(b.id)).toMatchObject({
        address: 'Weg 3',
        latitude: 52.5,
        longitude: 13.4,
      })
    })

    it('lets a resolution clear a field; ignores fields of other kinds', async () => {
      const { a, b } = await twoLocations()
      await details.setLocation(a.id, {
        address: 'Weg 1',
        latitude: null,
        longitude: null,
        merchant_id: null,
      })
      await details.setLocation(b.id, {
        address: 'Weg 2',
        latitude: null,
        longitude: null,
        merchant_id: null,
      })
      await repo.merge(a.id, b.id, { address: null, start_date: '2026-01-01' })
      expect(await details.getLocation(b.id)).toMatchObject({ address: null })
      expect(await db.exec('SELECT * FROM journey_details')).toEqual([])
    })

    it('creates the target row when missing, for merchants and journeys too', async () => {
      const food = await repo.create({ kind: 'category', name: 'Food' })
      const m1 = await repo.create({ kind: 'merchant', name: 'REWE' })
      const m2 = await repo.create({ kind: 'merchant', name: 'REWE Markt' })
      await details.setMerchant(m1.id, { default_category_id: food.id })
      await repo.merge(m1.id, m2.id)
      expect(await details.getMerchant(m2.id)).toEqual({
        tag_id: m2.id,
        default_category_id: food.id,
      })

      const j1 = await repo.create({ kind: 'journey', name: 'Rome' })
      const j2 = await repo.create({ kind: 'journey', name: 'Roma' })
      await details.setJourney(j1.id, { start_date: '2026-05-01', end_date: '2026-05-09' })
      await details.setJourney(j2.id, { start_date: '2026-05-02', end_date: null })
      expect((await repo.detailConflicts(j1.id, j2.id)).map((c) => c.field)).toEqual(['start_date'])
      await repo.merge(j1.id, j2.id, { start_date: '2026-05-01' })
      expect(await details.getJourney(j2.id)).toMatchObject({
        start_date: '2026-05-01',
        end_date: '2026-05-09',
      })
    })

    it('requires a resolved link to be a live tag of the right kind', async () => {
      const { a, b } = await twoLocations()
      const food = await repo.create({ kind: 'category', name: 'Food' })
      await expect(repo.merge(a.id, b.id, { merchant_id: food.id })).rejects.toThrow(
        TagKindMismatchError,
      )
      expect(await repo.findById(a.id)).toMatchObject({ merged_into_id: null })
    })

    it('detailConflicts lists the differing fields and refuses dead or mixed-kind tags', async () => {
      const { a, b } = await twoLocations()
      const food = await repo.create({ kind: 'category', name: 'Food' })
      await details.setLocation(a.id, {
        address: 'Weg 1',
        latitude: null,
        longitude: null,
        merchant_id: null,
      })
      await details.setLocation(b.id, {
        address: 'Weg 2',
        latitude: null,
        longitude: null,
        merchant_id: null,
      })
      expect(await repo.detailConflicts(a.id, b.id)).toEqual([
        { field: 'address', source: 'Weg 1', target: 'Weg 2' },
      ])
      await expect(repo.detailConflicts(a.id, food.id)).rejects.toThrow(TagKindMismatchError)
      await expect(repo.detailConflicts(a.id, asShortId('nonexistent1'))).rejects.toThrow(
        /not found/,
      )
    })
  })
})
