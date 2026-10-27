import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import {
  CategoryInUseError,
  DeletedTagError,
  DuplicateTagNameError,
  InvalidTagDetailsError,
  MergeConflictError,
  TagKindMismatchError,
  TagLoopError,
  TagNotFoundError,
} from '../../errors'
import { asShortId, type ShortId } from '../../shortId'
import type { TagKind } from '../../types'
import { mergedNames } from '@/tags/otherNames'
import { localMoment } from '../../LocalMoment'
import { moneyAmount, zeroMoney } from '../../MoneyAmount'
import { AccountsRepository } from '../AccountsRepository'
import { TransactionsRepository } from '../TransactionsRepository'
import { TagsRepository, type TagSaveInput } from '../TagsRepository'
import { TagDetailsRepository, readDetailValues } from '../TagDetailsRepository'

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
      `INSERT INTO tags (id, kind, name, parent_id, moved_at_utc, synonyms, merged_into_id,
                         created_at_utc, updated_at_utc, deleted_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.kind,
        row.name,
        row.parent ?? null,
        AT,
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
      DeletedTagError,
    )
    await expect(
      repo.create({ kind: 'tag', name: 'x', parent_id: asShortId('nowhere00000') }),
    ).rejects.toThrow(TagNotFoundError)
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

  it('sets moved_at_utc on create, move and the children a merge moves, and nowhere else', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const at = (day: number) => {
        const instant = new Date(Date.UTC(2026, 9, day))
        vi.setSystemTime(instant)
        return instant
      }
      const movedAt = async (id: ShortId) => (await repo.findById(id))!.moved_at_utc
      const t1 = at(2)
      const food = await repo.create({ kind: 'category', name: 'Food' })
      const fun = await repo.create({ kind: 'category', name: 'Fun' })
      const snacks = await repo.create({ kind: 'category', name: 'Snacks', parent_id: food.id })
      const chips = await repo.create({ kind: 'category', name: 'Chips', parent_id: snacks.id })
      expect(snacks).toMatchObject({ moved_at_utc: t1, created_at_utc: t1 })

      const t2 = at(3)
      await repo.move(snacks.id, fun.id)
      expect(await movedAt(snacks.id)).toEqual(t2)

      at(4)
      await repo.update(snacks.id, { name: 'Snack food' })
      expect(await movedAt(snacks.id)).toEqual(t2)
      // A delete lifts the live children, a restore may lift the tag: neither is a move.
      await repo.softDelete(snacks.id)
      expect(await repo.findById(chips.id)).toMatchObject({ parent_id: fun.id, moved_at_utc: t1 })
      await repo.restore(snacks.id)
      expect(await movedAt(snacks.id)).toEqual(t2)

      const t5 = at(5)
      await repo.merge(fun.id, food.id)
      expect(await repo.findById(snacks.id)).toMatchObject({ parent_id: food.id, moved_at_utc: t5 })
      expect(await repo.findById(chips.id)).toMatchObject({ parent_id: food.id, moved_at_utc: t5 })
      expect(await movedAt(food.id)).toEqual(t1)
    } finally {
      vi.useRealTimers()
    }
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

    await expect(repo.restore(merged)).rejects.toThrow(DeletedTagError)
    await expect(repo.restore(merged)).rejects.toThrow(/merged/)
    await expect(repo.restore(asShortId('nowhere00000'))).rejects.toThrow(TagNotFoundError)
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

  describe('findByName through merged tags', () => {
    // A chain merged on two devices, as sync leaves it: job → work → employment,
    // with "job" on no live tag (Z took only "work" from Y).
    let employment: ShortId
    beforeEach(async () => {
      employment = await insertRaw({
        id: 'employment01',
        kind: 'tag',
        name: 'employment',
        synonyms: ['work'],
      })
      const work = await insertRaw({
        id: 'work00000001',
        kind: 'tag',
        name: 'work',
        deleted: AT,
        mergedInto: employment,
      })
      await insertRaw({
        id: 'job000000001',
        kind: 'tag',
        name: 'job',
        synonyms: ['occupation'],
        deleted: AT,
        mergedInto: work,
      })
    })

    it('answers a merged name or synonym with the live end of its chain', async () => {
      expect((await repo.findByName('tag', 'JOB'))?.id).toBe(employment)
      expect((await repo.findByName('tag', 'occupation', null))?.id).toBe(employment)
      expect(await repo.findByName('merchant', 'job')).toBeNull()
      // The merged tag sits at the top level, not under another parent.
      const other = await insertRaw({ id: 'other0000001', kind: 'tag', name: 'other' })
      expect(await repo.findByName('tag', 'job', other)).toBeNull()
    })

    it('prefers a live match', async () => {
      const gig = await repo.create({ kind: 'tag', name: 'gig', synonyms: ['job'] })
      expect((await repo.findByName('tag', 'job'))?.id).toBe(gig.id)
    })

    it('skips a chain that ends at a deleted tag, and a cycle', async () => {
      const gone = await insertRaw({ id: 'gone00000001', kind: 'tag', name: 'gone', deleted: AT })
      await insertRaw({
        id: 'side00000001',
        kind: 'tag',
        name: 'side job',
        deleted: AT,
        mergedInto: gone,
      })
      expect(await repo.findByName('tag', 'side job')).toBeNull()

      // Another merged tag of that name (after it in id order) whose chain ends live answers instead.
      await insertRaw({
        id: 'side00000002',
        kind: 'tag',
        name: 'Side job',
        deleted: AT,
        mergedInto: employment,
      })
      expect((await repo.findByName('tag', 'side job'))?.id).toBe(employment)

      // A merge cycle sync brought in (and has not repaired yet) leads nowhere.
      const a = await insertRaw({ id: 'cycleA000001', kind: 'tag', name: 'loop', deleted: AT })
      await insertRaw({ id: 'cycleB000001', kind: 'tag', name: 'b', deleted: AT, mergedInto: a })
      await db.run(`UPDATE tags SET merged_into_id = 'cycleB000001' WHERE id = ?`, [a])
      expect(await repo.findByName('tag', 'loop')).toBeNull()
    })
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
    await expect(repo.merge(gone.id, rewe.id)).rejects.toThrow(DeletedTagError)
    await expect(repo.merge(rewe.id, gone.id)).rejects.toThrow(DeletedTagError)
    await expect(repo.merge(rewe.id, asShortId('nowhere00000'))).rejects.toThrow(TagNotFoundError)
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

  describe('save', () => {
    let details: TagDetailsRepository
    beforeEach(() => {
      details = new TagDetailsRepository(db)
    })

    /** The input that saves the tag as it is. */
    async function asIs(id: ShortId): Promise<TagSaveInput> {
      const tag = (await repo.findById(id))!
      return {
        name: tag.name,
        parent_id: tag.parent_id,
        description: tag.description,
        otherNames: [...tag.synonyms, ...mergedNames(tag, await repo.listAll())],
        colour: tag.colour,
        icon: tag.icon,
        details: await readDetailValues(db, id, tag.kind),
      }
    }

    async function shopInBerlin() {
      const berlin = await repo.create({ kind: 'location', name: 'Berlin' })
      const munich = await repo.create({ kind: 'location', name: 'Munich' })
      const shop = await repo.create({ kind: 'location', name: 'Shop', parent_id: berlin.id })
      await details.setLocation(shop.id, {
        address: 'Weg 1',
        latitude: null,
        longitude: null,
        merchant_id: null,
      })
      return { berlin, munich, shop }
    }

    it('renames, moves and writes details in one go', async () => {
      const { munich, shop } = await shopInBerlin()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const later = new Date(Date.UTC(2030, 0, 1))
        vi.setSystemTime(later)
        await repo.save(shop.id, {
          ...(await asIs(shop.id)),
          name: 'Rewe',
          parent_id: munich.id,
          otherNames: ['REWE Markt'],
          details: {
            ...(await asIs(shop.id)).details,
            address: 'Main St 1',
            position: { latitude: 48.1, longitude: 11.6 },
          },
        })
        expect(await repo.findById(shop.id)).toMatchObject({
          name: 'Rewe',
          parent_id: munich.id,
          synonyms: ['REWE Markt'],
          moved_at_utc: later,
          updated_at_utc: later,
        })
        expect(await details.getLocation(shop.id)).toMatchObject({
          address: 'Main St 1',
          latitude: 48.1,
          longitude: 11.6,
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('changes nothing when the name is taken at the new parent', async () => {
      const { berlin, munich, shop } = await shopInBerlin()
      await repo.create({ kind: 'location', name: 'Rewe', parent_id: munich.id })
      await expect(
        repo.save(shop.id, {
          ...(await asIs(shop.id)),
          name: 'rewe',
          parent_id: munich.id,
          details: { ...(await asIs(shop.id)).details, address: 'Main St 1' },
        }),
      ).rejects.toThrow(DuplicateTagNameError)
      expect(await repo.findById(shop.id)).toMatchObject({ name: 'Shop', parent_id: berlin.id })
      expect(await details.getLocation(shop.id)).toMatchObject({ address: 'Weg 1' })
    })

    it('checks every name at a new parent, not only the changed ones', async () => {
      const { munich, shop } = await shopInBerlin()
      await repo.create({ kind: 'location', name: 'Shop', parent_id: munich.id })
      await expect(
        repo.save(shop.id, { ...(await asIs(shop.id)), parent_id: munich.id }),
      ).rejects.toThrow(DuplicateTagNameError)
    })

    it('refuses a move under its own descendant and changes nothing', async () => {
      const food = await repo.create({ kind: 'category', name: 'Food' })
      const groceries = await repo.create({
        kind: 'category',
        name: 'Groceries',
        parent_id: food.id,
      })
      const error = await repo
        .save(food.id, { ...(await asIs(food.id)), parent_id: groceries.id, description: 'Eats' })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TagLoopError)
      expect((error as TagLoopError).path).toEqual(['Food', 'Groceries'])
      expect(await repo.findById(food.id)).toMatchObject({ parent_id: null, description: null })
    })

    it('refuses a parent of another kind', async () => {
      const food = await repo.create({ kind: 'category', name: 'Food' })
      const rewe = await repo.create({ kind: 'merchant', name: 'Rewe' })
      await expect(
        repo.save(rewe.id, { ...(await asIs(rewe.id)), parent_id: food.id }),
      ).rejects.toThrow(TagKindMismatchError)
    })

    it('does not bump updated_at_utc when nothing changed', async () => {
      const { shop } = await shopInBerlin()
      const before = (await repo.findById(shop.id))!
      const detailsBefore = await db.exec('SELECT * FROM location_details WHERE tag_id = ?', [
        shop.id,
      ])
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date(Date.UTC(2030, 0, 1)))
        // '' is no description and no address, as NULL is.
        const input = await asIs(shop.id)
        await repo.save(shop.id, { ...input, description: '', otherNames: [' '] })
      } finally {
        vi.useRealTimers()
      }
      expect(await repo.findById(shop.id)).toEqual(before)
      expect(await db.exec('SELECT * FROM location_details WHERE tag_id = ?', [shop.id])).toEqual(
        detailsBefore,
      )
    })

    it('does not re-check names the tag already had at its parent', async () => {
      // Two siblings with one name, as a sync leaves them.
      const a = await insertRaw({ id: 'reweA0000001', kind: 'merchant', name: 'Rewe' })
      await insertRaw({ id: 'reweB0000001', kind: 'merchant', name: 'Rewe' })
      await repo.save(a, { ...(await asIs(a)), description: 'The supermarket' })
      expect(await repo.findById(a)).toMatchObject({ description: 'The supermarket' })
    })

    it('trims other names and drops empty ones, the main name and repeats', async () => {
      const rewe = await repo.create({ kind: 'merchant', name: 'Rewe' })
      await repo.save(rewe.id, {
        ...(await asIs(rewe.id)),
        otherNames: [' REWE Markt ', '', 'rewe', 'Rewe markt', 'Billa'],
      })
      expect((await repo.findById(rewe.id))!.synonyms).toEqual(['REWE Markt', 'Billa'])
    })

    it('keeps a link to a tag deleted since', async () => {
      const { shop } = await shopInBerlin()
      const rewe = await repo.create({ kind: 'merchant', name: 'Rewe' })
      await details.setLocation(shop.id, {
        address: 'Weg 1',
        latitude: null,
        longitude: null,
        merchant_id: rewe.id,
      })
      await repo.softDelete(rewe.id)
      const input = await asIs(shop.id)
      await repo.save(shop.id, { ...input, details: { ...input.details, address: 'Weg 2' } })
      expect(await details.getLocation(shop.id)).toMatchObject({
        address: 'Weg 2',
        merchant_id: rewe.id,
      })
    })

    it('refuses a new link to a deleted tag', async () => {
      const { shop } = await shopInBerlin()
      const rewe = await repo.create({ kind: 'merchant', name: 'Rewe' })
      await repo.softDelete(rewe.id)
      const input = await asIs(shop.id)
      await expect(
        repo.save(shop.id, { ...input, details: { ...input.details, merchant_id: rewe.id } }),
      ).rejects.toThrow(DeletedTagError)
    })

    it('refuses journey dates that end before they start', async () => {
      const rome = await repo.create({ kind: 'journey', name: 'Rome' })
      const input = await asIs(rome.id)
      await expect(
        repo.save(rome.id, {
          ...input,
          details: { ...input.details, start_date: '2026-05-09', end_date: '2026-05-01' },
        }),
      ).rejects.toThrow(InvalidTagDetailsError)
    })

    it('ignores detail fields of other kinds', async () => {
      const food = await repo.create({ kind: 'category', name: 'Food' })
      const input = await asIs(food.id)
      await repo.save(food.id, { ...input, details: { ...input.details, address: 'Weg 1' } })
      expect(await db.exec('SELECT * FROM location_details')).toEqual([])
    })

    it('refuses a deleted tag', async () => {
      const food = await repo.create({ kind: 'category', name: 'Food' })
      const input = await asIs(food.id)
      await repo.softDelete(food.id)
      await expect(repo.save(food.id, input)).rejects.toThrow(DeletedTagError)
    })

    describe('retired names', () => {
      it('a removed merged name no longer finds the tag', async () => {
        const job = await repo.create({ kind: 'tag', name: 'job', synonyms: ['occupation'] })
        const work = await repo.create({ kind: 'tag', name: 'work' })
        await repo.merge(job.id, work.id)
        await repo.save(work.id, { ...(await asIs(work.id)), otherNames: ['occupation'] })

        expect(await repo.findById(work.id)).toMatchObject({
          synonyms: ['occupation'],
          retired_names: ['job'],
        })
        expect(await repo.findByName('tag', 'job')).toBeNull()
        expect((await repo.findByName('tag', 'occupation'))?.id).toBe(work.id)
        expect((await repo.findByName('tag', 'work'))?.id).toBe(work.id)
      })

      it('retires a name only the merged tag holds', async () => {
        // A chain merged on two devices: the end never got the name as a synonym.
        const work = await repo.create({ kind: 'tag', name: 'work' })
        await insertRaw({
          id: 'job000000001',
          kind: 'tag',
          name: 'job',
          deleted: AT,
          mergedInto: work.id,
        })
        expect((await repo.findByName('tag', 'job'))?.id).toBe(work.id)

        await repo.save(work.id, await asIs(work.id)) // lists it: nothing changes
        expect((await repo.findById(work.id))!.retired_names).toEqual([])

        await repo.save(work.id, { ...(await asIs(work.id)), otherNames: [] })
        expect((await repo.findById(work.id))!.retired_names).toEqual(['job'])
        expect(await repo.findByName('tag', 'job')).toBeNull()
      })

      it('keeps a merged-only name that is listed', async () => {
        const work = await repo.create({ kind: 'tag', name: 'work' })
        await insertRaw({
          id: 'job000000001',
          kind: 'tag',
          name: 'job',
          deleted: AT,
          mergedInto: work.id,
        })
        await repo.save(work.id, { ...(await asIs(work.id)), otherNames: ['job'] })
        expect(await repo.findById(work.id)).toMatchObject({ synonyms: [], retired_names: [] })
        expect((await repo.findByName('tag', 'job'))?.id).toBe(work.id)
      })

      it('a name typed again finds the tag again', async () => {
        const job = await repo.create({ kind: 'tag', name: 'job' })
        const work = await repo.create({ kind: 'tag', name: 'work' })
        await repo.merge(job.id, work.id)
        await repo.save(work.id, { ...(await asIs(work.id)), otherNames: [] })
        await repo.save(work.id, { ...(await asIs(work.id)), otherNames: ['Job'] })
        expect(await repo.findById(work.id)).toMatchObject({
          synonyms: ['Job'],
          retired_names: [],
        })

        await repo.update(work.id, { synonyms: [] })
        await repo.save(work.id, { ...(await asIs(work.id)), otherNames: [] })
        await repo.update(work.id, { synonyms: ['job'] })
        expect((await repo.findById(work.id))!.retired_names).toEqual([])
      })

      it('a retired name stays retired after a further merge', async () => {
        const job = await repo.create({ kind: 'tag', name: 'job' })
        const work = await repo.create({ kind: 'tag', name: 'work' })
        const employment = await repo.create({ kind: 'tag', name: 'employment' })
        await repo.merge(job.id, work.id)
        await repo.save(work.id, { ...(await asIs(work.id)), otherNames: [] })
        await repo.merge(work.id, employment.id)

        expect(await repo.findById(employment.id)).toMatchObject({
          synonyms: ['work'],
          retired_names: ['job'],
        })
        expect(await repo.findByName('tag', 'job')).toBeNull()
        expect((await repo.findByName('tag', 'work'))?.id).toBe(employment.id)
      })

      it('is skipped on any tag of the chain, not only at its end', async () => {
        const end = await repo.create({ kind: 'tag', name: 'employment' })
        await db.run(
          `INSERT INTO tags (id, kind, name, parent_id, moved_at_utc, synonyms, retired_names,
                             merged_into_id, created_at_utc, updated_at_utc, deleted_at_utc)
           VALUES ('work00000001', 'tag', 'work', NULL, ?, '[]', '["job"]', ?, ?, ?, ?)`,
          [AT, end.id, AT, AT, AT],
        )
        await insertRaw({
          id: 'job000000001',
          kind: 'tag',
          name: 'job',
          deleted: AT,
          mergedInto: 'work00000001',
        })
        expect(await repo.findByName('tag', 'job')).toBeNull()
        expect((await repo.findByName('tag', 'work'))?.id).toBe(end.id)
      })

      it('defaults to none and round-trips', async () => {
        const work = await repo.create({ kind: 'tag', name: 'work' })
        expect(work.retired_names).toEqual([])
        expect((await repo.listAll())[0]!.retired_names).toEqual([])
      })
    })
  })

  describe('create with details', () => {
    let details: TagDetailsRepository
    beforeEach(() => {
      details = new TagDetailsRepository(db)
    })

    const none = {
      address: null,
      position: null,
      merchant_id: null,
      default_category_id: null,
      start_date: null,
      end_date: null,
    }

    it('writes the details in the same transaction', async () => {
      const groceries = await repo.create({ kind: 'category', name: 'Groceries' })
      const rewe = await repo.create({
        kind: 'merchant',
        name: 'Rewe',
        details: { ...none, default_category_id: groceries.id },
      })
      expect(await details.getMerchant(rewe.id)).toEqual({
        tag_id: rewe.id,
        default_category_id: groceries.id,
      })
    })

    it('creates no tag when the details are refused', async () => {
      const groceries = await repo.create({ kind: 'category', name: 'Groceries' })
      await repo.softDelete(groceries.id)
      await expect(
        repo.create({
          kind: 'merchant',
          name: 'Rewe',
          details: { ...none, default_category_id: groceries.id },
        }),
      ).rejects.toThrow(DeletedTagError)
      expect(await repo.findByName('merchant', 'Rewe')).toBeNull()
    })

    it('writes no details row when every field is empty', async () => {
      await repo.create({ kind: 'journey', name: 'Rome', details: none })
      expect(await db.exec('SELECT * FROM journey_details')).toEqual([])
    })
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
      // setLocation refuses a lone coordinate; old data or a sync can still hold one.
      await db.run(
        `INSERT INTO location_details (tag_id, latitude, created_at_utc, updated_at_utc)
         VALUES (?, 1, ?, ?)`,
        [a.id, AT, AT],
      )
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
        TagNotFoundError,
      )
    })

    it('is not blocked by a link the target already has to a tag deleted since', async () => {
      const food = await repo.create({ kind: 'category', name: 'Food' })
      const m1 = await repo.create({ kind: 'merchant', name: 'REWE' })
      const m2 = await repo.create({ kind: 'merchant', name: 'REWE Markt' })
      await details.setMerchant(m2.id, { default_category_id: food.id })
      await repo.softDelete(food.id) // allowed: no transaction uses it

      await repo.merge(m1.id, m2.id)
      expect(await repo.findById(m1.id)).toBeNull()
      expect((await details.getMerchant(m2.id))!.default_category_id).toBe(food.id)
    })

    it("fills the target's empty default category with the source's link to a deleted one", async () => {
      const food = await repo.create({ kind: 'category', name: 'Food' })
      const m1 = await repo.create({ kind: 'merchant', name: 'REWE' })
      const m2 = await repo.create({ kind: 'merchant', name: 'REWE Markt' })
      await details.setMerchant(m1.id, { default_category_id: food.id })
      await repo.softDelete(food.id)

      await repo.merge(m1.id, m2.id)
      expect(await repo.findById(m1.id)).toBeNull()
      expect((await details.getMerchant(m2.id))!.default_category_id).toBe(food.id)
    })

    it("fills the target's empty merchant with the source's link to a merchant deleted since", async () => {
      const { a, b } = await twoLocations()
      const rewe = await repo.create({ kind: 'merchant', name: 'REWE' })
      await details.setLocation(a.id, {
        address: null,
        latitude: null,
        longitude: null,
        merchant_id: rewe.id,
      })
      await repo.softDelete(rewe.id)

      await repo.merge(a.id, b.id)
      expect((await details.getLocation(b.id))!.merchant_id).toBe(rewe.id)
    })

    it('still refuses a resolved link on neither side that is deleted', async () => {
      const food = await repo.create({ kind: 'category', name: 'Food' })
      const drinks = await repo.create({ kind: 'category', name: 'Drinks' })
      const m1 = await repo.create({ kind: 'merchant', name: 'REWE' })
      const m2 = await repo.create({ kind: 'merchant', name: 'REWE Markt' })
      await details.setMerchant(m1.id, { default_category_id: food.id })
      await repo.softDelete(food.id)
      await repo.softDelete(drinks.id)

      await expect(repo.merge(m1.id, m2.id, { default_category_id: drinks.id })).rejects.toThrow(
        DeletedTagError,
      )
      expect(await repo.findById(m1.id)).toMatchObject({ merged_into_id: null })
      expect(await details.getMerchant(m2.id)).toBeNull()
    })

    it("accepts a resolved link equal to the source's deleted one", async () => {
      const { a, b } = await twoLocations()
      const rewe = await repo.create({ kind: 'merchant', name: 'REWE' })
      const edeka = await repo.create({ kind: 'merchant', name: 'EDEKA' })
      const link = (merchant_id: ShortId) => ({
        address: null,
        latitude: null,
        longitude: null,
        merchant_id,
      })
      await details.setLocation(a.id, link(rewe.id))
      await details.setLocation(b.id, link(edeka.id))
      await repo.softDelete(rewe.id)

      await repo.merge(a.id, b.id, { merchant_id: rewe.id })
      expect((await details.getLocation(b.id))!.merchant_id).toBe(rewe.id)
    })

    it('checks changed journey dates', async () => {
      const j1 = await repo.create({ kind: 'journey', name: 'Rome' })
      const j2 = await repo.create({ kind: 'journey', name: 'Roma' })
      await details.setJourney(j1.id, { start_date: '2026-05-10', end_date: null })
      await details.setJourney(j2.id, { start_date: null, end_date: '2026-05-05' })

      // Filling the empty ends would leave the journey ending before it starts.
      await expect(repo.merge(j1.id, j2.id)).rejects.toThrow(InvalidTagDetailsError)
      await expect(repo.merge(j1.id, j2.id, { start_date: '2026-02-30' })).rejects.toThrow(
        InvalidTagDetailsError,
      )
      expect(await repo.findById(j1.id)).toMatchObject({ merged_into_id: null })

      await repo.merge(j1.id, j2.id, { start_date: '2026-05-01' })
      expect(await details.getJourney(j2.id)).toMatchObject({
        start_date: '2026-05-01',
        end_date: '2026-05-05',
      })
    })
  })
})
