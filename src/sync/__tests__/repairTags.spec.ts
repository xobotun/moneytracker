import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database, SqlExecutor } from '../../db/Database'
import type { SyncRow } from '../types'
import { readRows } from '../rows'
import { repairTags, type TagSnapshot } from '../repairTags'
import { newMigratedDb, seedTag } from './helpers'

// repairTags on one database holding the merged state, with hand-made
// snapshots of what each side had before the merge.

const CUT = '2026-05-01T00:00:00.000Z'
const T1 = '2026-05-05T00:00:00.000Z'
const T2 = '2026-05-06T00:00:00.000Z'
const T3 = '2026-05-07T00:00:00.000Z'

describe('repairTags', () => {
  let db: Database

  beforeEach(async () => {
    db = await newMigratedDb()
  })

  afterEach(async () => {
    await db.close()
  })

  /** A category tag, live unless `deleted`; `moved` defaults to `updated` (the last change was a move). */
  async function tag(
    id: string,
    opts: {
      parent?: string
      updated?: string
      moved?: string
      deleted?: string
      mergedInto?: string
    } = {},
  ): Promise<void> {
    // Rows of a merged state may point at tags seeded after them: foreign keys
    // are off for the insert (turning them on again checks nothing).
    await db.run('PRAGMA foreign_keys = OFF')
    await seedTag(db, {
      id,
      name: id,
      kind: 'category',
      parentId: opts.parent ?? null,
      mergedIntoId: opts.mergedInto ?? null,
      created: CUT,
      updated: opts.updated ?? opts.deleted ?? CUT,
      moved: opts.moved,
      deleted: opts.deleted ?? null,
    })
    await db.run('PRAGMA foreign_keys = ON')
  }

  async function txn(
    id: string,
    opts: { tags?: unknown; categories?: unknown; merchant?: string; deleted?: string } = {},
  ): Promise<void> {
    await db.run(
      `INSERT INTO transactions (id, amount_value__from, amount_scale__from, amount_currency__from,
         amount_value__to, amount_scale__to, amount_currency__to,
         transaction_at_local, transaction_at_zone, tags, categories, merchant_id,
         created_at_utc, updated_at_utc, deleted_at_utc)
       VALUES (?, 100, 2, 'EUR', 100, 2, 'EUR', '2026-05-01T09:00:00.000+00:00', 'UTC',
               ?, ?, ?, ?, ?, ?)`,
      [
        id,
        JSON.stringify(opts.tags ?? []),
        JSON.stringify(opts.categories ?? []),
        opts.merchant ?? null,
        CUT,
        opts.deleted ?? CUT,
        opts.deleted ?? null,
      ],
    )
  }

  /** A category part of the whole 1.00 EUR. */
  const part = (categoryId: string) => ({
    category_id: categoryId,
    amount_value__from: 100,
    amount_scale__from: 2,
    amount_value__to: 100,
    amount_scale__to: 2,
  })

  /**
   * One side's tags before the merge: the merged rows, with `changes` applied
   * to the rows that side had otherwise (null: the side lacked the row).
   */
  async function side(changes: Record<string, Partial<SyncRow> | null> = {}): Promise<TagSnapshot> {
    const map = new Map<string, SyncRow>()
    for (const row of await readRows(db, 'tags')) map.set(row.id as string, row)
    for (const [id, change] of Object.entries(changes)) {
      if (change === null) map.delete(id)
      else map.set(id, { ...map.get(id)!, ...change })
    }
    return map
  }

  const repair = (local: TagSnapshot, remote: TagSnapshot) =>
    db.transaction((tx) => repairTags(tx, { local, remote }))

  const tagRow = async (id: string) => (await db.exec('SELECT * FROM tags WHERE id = ?', [id]))[0]!

  const parents = async () =>
    Object.fromEntries(
      (
        await db.exec<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM tags')
      ).map((r) => [r.id, r.parent_id]),
    )

  it('returns no conflicts and writes nothing when there is nothing to repair', async () => {
    await tag('food')
    await tag('fruit', { parent: 'food' })
    await tag('old', { deleted: T1 })
    await txn('t1', { tags: ['food'] })
    const before = db.mutationCounter

    expect(await repair(await side(), await side())).toEqual([])
    expect(db.mutationCounter).toBe(before)
  })

  it('lifts to the nearest live ancestor, or the top level', async () => {
    await tag('root')
    await tag('gone1', { parent: 'root', deleted: T1 })
    await tag('gone2', { parent: 'gone1', deleted: T1 })
    await tag('deep', { parent: 'gone2', updated: T2 })
    await tag('orphanParent', { deleted: T1 })
    await tag('orphan', { parent: 'orphanParent', updated: T2 })
    // A deleted tag under a deleted one is left alone: nobody sees it.
    await tag('deadChild', { parent: 'gone1', deleted: T1 })

    expect(await repair(await side(), await side())).toEqual([])

    expect(await tagRow('deep')).toMatchObject({ parent_id: 'root', updated_at_utc: T2 })
    expect(await tagRow('orphan')).toMatchObject({ parent_id: null, updated_at_utc: T2 })
    expect(await tagRow('deadChild')).toMatchObject({ parent_id: 'gone1' })
  })

  it('undoes a three-tag loop at its latest move', async () => {
    await tag('p')
    await tag('a', { parent: 'b', updated: T1 })
    await tag('b', { parent: 'c', updated: T2 })
    await tag('c', { parent: 'a', updated: T3 })
    // C's move came from the remote; this device had C under P.
    const local = await side({ c: { parent_id: 'p', updated_at_utc: CUT } })
    const remote = await side({ a: { parent_id: null, updated_at_utc: CUT } })

    const conflicts = await repair(local, remote)

    expect(await parents()).toMatchObject({ a: 'b', b: 'c', c: 'p' })
    expect(conflicts).toEqual([
      {
        table: 'tags',
        primaryKey: 'c',
        local: local.get('c'),
        remote: remote.get('c'),
        winner: 'local',
        resolution: 'loop-undone',
      },
    ])
    expect(((await tagRow('c')).updated_at_utc as string) > T3).toBe(true)
  })

  it('puts the undone tag at the top level when the other side lacks it', async () => {
    await tag('a', { parent: 'b', updated: T1 })
    await tag('b', { parent: 'a', updated: T2 })
    // B was created on the remote, under A.
    const local = await side({ b: null })

    const conflicts = await repair(local, await side())

    expect(await parents()).toMatchObject({ a: 'b', b: null })
    expect(conflicts).toEqual([
      expect.objectContaining({ primaryKey: 'b', local: {}, winner: 'local' }),
    ])
  })

  it('takes the remote parent when the local row won', async () => {
    await tag('q')
    await tag('a', { parent: 'b', updated: T1 })
    await tag('b', { parent: 'a', updated: T2 })
    const remote = await side({ b: { parent_id: 'q', updated_at_utc: CUT } })

    const conflicts = await repair(await side(), remote)

    expect(await parents()).toMatchObject({ a: 'b', b: 'q' })
    expect(conflicts).toEqual([expect.objectContaining({ primaryKey: 'b', winner: 'remote' })])
  })

  it('breaks a tie on moved_at_utc by the greatest id', async () => {
    await tag('p')
    await tag('a', { parent: 'b', updated: T1 })
    await tag('b', { parent: 'a', updated: T1 })
    const local = await side({
      a: { parent_id: 'p', moved_at_utc: CUT, updated_at_utc: CUT },
      b: { parent_id: 'p', moved_at_utc: CUT, updated_at_utc: CUT },
    })

    const conflicts = await repair(local, await side())

    expect(await parents()).toMatchObject({ a: 'b', b: 'p' })
    expect(conflicts.map((c) => c.primaryKey)).toEqual(['b'])
  })

  it('undoes a loop at the tag moved last, not at the one changed last', async () => {
    await tag('p')
    // A was moved first and renamed afterwards; B was moved last.
    await tag('a', { parent: 'b', moved: T1, updated: T3 })
    await tag('b', { parent: 'a', moved: T2, updated: T2 })
    const local = await side({ b: { parent_id: 'p', moved_at_utc: CUT, updated_at_utc: CUT } })

    const conflicts = await repair(local, await side())

    expect(await parents()).toMatchObject({ a: 'b', b: 'p' })
    expect(conflicts.map((c) => c.primaryKey)).toEqual(['b'])
    // The undo is a repair, not a user's move: only updated_at_utc is bumped.
    const b = await tagRow('b')
    expect(b.moved_at_utc).toBe(T2)
    expect((b.updated_at_utc as string) > T2).toBe(true)
  })

  it('moves the undone tag to the top level when its other-side parent keeps a loop', async () => {
    await tag('a', { parent: 'b', updated: T1 })
    await tag('b', { parent: 'c', updated: T2 })
    await tag('c', { parent: 'a', updated: T3 })
    // On this device C sat under B: going back there still loops (B → C → B).
    const local = await side({ c: { parent_id: 'b', updated_at_utc: CUT } })

    const conflicts = await repair(local, await side())

    expect(await parents()).toMatchObject({ a: 'b', b: 'c', c: null })
    expect(conflicts.map((c) => c.primaryKey)).toEqual(['c'])
  })

  it('resolves the other-side parent through merges and deletions', async () => {
    await tag('root')
    await tag('gone', { parent: 'root', deleted: T1 })
    await tag('target')
    await tag('merged', { mergedInto: 'target', deleted: T1 })
    await tag('a', { parent: 'b', updated: T1 })
    await tag('b', { parent: 'a', updated: T2 })
    await tag('c', { parent: 'd', updated: T1 })
    await tag('d', { parent: 'c', updated: T2 })
    // On this device B sat under a tag since deleted, D under one since merged.
    const local = await side({
      b: { parent_id: 'gone', updated_at_utc: CUT },
      d: { parent_id: 'merged', updated_at_utc: CUT },
    })

    await repair(local, await side())

    expect(await parents()).toMatchObject({ b: 'root', d: 'target' })
  })

  it('restores the latest tag of a merge cycle and redirects the others to it', async () => {
    await tag('x', { mergedInto: 'y', deleted: T1 })
    await tag('y', { mergedInto: 'z', deleted: T3 })
    await tag('z', { mergedInto: 'x', deleted: T2 })
    await tag('child', { parent: 'z' })
    await txn('t1', { tags: ['x', 'z'], merchant: 'z', categories: [part('x')] })
    // This device merged Y into Z; on the remote Y is live, and got X's name
    // as a synonym when X was merged into it there.
    const remote = await side({
      y: { merged_into_id: null, deleted_at_utc: null, updated_at_utc: CUT, synonyms: '["x"]' },
    })

    const conflicts = await repair(await side(), remote)

    // Y comes back as the remote had it, one millisecond after the cycle's
    // latest change — the same row on every device that restores it.
    expect(await tagRow('y')).toMatchObject({
      merged_into_id: null,
      deleted_at_utc: null,
      synonyms: '["x"]',
      updated_at_utc: '2026-05-07T00:00:00.001Z',
    })
    expect(await tagRow('x')).toMatchObject({ merged_into_id: 'y' })
    expect(await tagRow('z')).toMatchObject({ merged_into_id: 'x' })
    expect(await tagRow('child')).toMatchObject({ parent_id: 'y' })
    const t1 = (await db.exec('SELECT * FROM transactions'))[0]!
    expect(t1).toMatchObject({ tags: '["y"]', merchant_id: 'y' })
    expect(JSON.parse(t1.categories as string)).toEqual([part('y')])
    expect(conflicts).toEqual([
      expect.objectContaining({ primaryKey: 'y', resolution: 'loop-undone', winner: 'remote' }),
    ])
  })

  it('restores the merged row of a cycle’s tag that no side had live', async () => {
    await tag('x', { mergedInto: 'y', deleted: T1 })
    await tag('y', { mergedInto: 'x', deleted: T2 })
    await db.run(`UPDATE tags SET synonyms = '["kept"]' WHERE id = 'y'`)

    await repair(await side(), await side())

    expect(await tagRow('y')).toMatchObject({
      merged_into_id: null,
      deleted_at_utc: null,
      synonyms: '["kept"]',
      updated_at_utc: '2026-05-06T00:00:00.001Z',
    })
  })

  describe('the stamp of a merge-cycle restore', () => {
    // X merged into Y on this device (T1), Y into X on the other (T2, the
    // later merge): Y is restored as this device has it.
    beforeEach(async () => {
      await tag('x', { mergedInto: 'y', deleted: T1 })
      await tag('y', { mergedInto: 'x', deleted: T2 })
    })
    const liveY = (change: Partial<SyncRow>) =>
      side({ y: { merged_into_id: null, deleted_at_utc: null, ...change } })

    it('is one millisecond after the cycle’s latest change when the live row is older', async () => {
      await repair(await liveY({ updated_at_utc: T1 }), await side())

      expect(await tagRow('y')).toMatchObject({ updated_at_utc: '2026-05-06T00:00:00.001Z' })
    })

    it('is the live row’s own time when that is later, so the edit it carries stays newest', async () => {
      await repair(await liveY({ name: 'labour', updated_at_utc: T3 }), await side())

      expect(await tagRow('y')).toMatchObject({
        name: 'labour',
        deleted_at_utc: null,
        updated_at_utc: T3,
      })
    })

    it('stays the same when the live row is a restore already', async () => {
      // The other device met the cycle first and uploaded its restore.
      const restoredAt = '2026-05-06T00:00:00.001Z'
      await repair(await liveY({ updated_at_utc: restoredAt }), await side())

      expect(await tagRow('y')).toMatchObject({ updated_at_utc: restoredAt })
    })
  })

  it('redirects any number of merged tags in the same number of statements', async () => {
    async function statementsFor(count: number): Promise<number> {
      await db.close()
      db = await newMigratedDb()
      await tag('target')
      for (let i = 0; i < count; i++) {
        await tag(`m${i}`, { mergedInto: 'target', deleted: T1 })
        await txn(`t${i}`, { tags: [`m${i}`], merchant: `m${i}`, categories: [part(`m${i}`)] })
      }
      let statements = 0
      const counted = (tx: SqlExecutor): SqlExecutor => ({
        exec: (sql, params) => {
          statements++
          return tx.exec(sql, params)
        },
        run: (sql, params) => {
          statements++
          return tx.run(sql, params)
        },
      })
      const snapshot = await side()
      await db.transaction((tx) => repairTags(counted(tx), { local: snapshot, remote: snapshot }))
      const rows = await db.exec<{ tags: string }>('SELECT tags FROM transactions')
      expect(rows.every((r) => r.tags === '["target"]')).toBe(true)
      return statements
    }

    expect(await statementsFor(10)).toBe(await statementsFor(1))
  })

  describe('a deleted category in use', () => {
    it('is restored one millisecond after its delete, and reported', async () => {
      await tag('fun', { deleted: T1 })
      await txn('t1', { categories: [part('fun')] })
      // This device recorded t1 on Fun; the other one deleted Fun.
      const local = await side({ fun: { deleted_at_utc: null, updated_at_utc: CUT } })
      const remote = await side()

      const conflicts = await repair(local, remote)

      expect(await tagRow('fun')).toMatchObject({
        deleted_at_utc: null,
        updated_at_utc: '2026-05-05T00:00:00.001Z',
        moved_at_utc: T1,
      })
      expect(conflicts).toEqual([
        {
          table: 'tags',
          primaryKey: 'fun',
          local: local.get('fun'),
          remote: remote.get('fun'),
          winner: 'local',
          resolution: 'delete-undone',
        },
      ])
    })

    it('is restored when the redirect moved a transaction onto it, and lifted', async () => {
      // One device merged X into Y; the other deleted Y and its parent.
      await tag('root', { deleted: T1 })
      await tag('y', { parent: 'root', deleted: T2 })
      await tag('x', { mergedInto: 'y', deleted: T1 })
      await txn('t1', { categories: [part('x')] })
      const local = await side({ y: { deleted_at_utc: null, updated_at_utc: CUT } })

      const conflicts = await repair(local, await side())

      expect(await tagRow('y')).toMatchObject({
        deleted_at_utc: null,
        parent_id: null,
        updated_at_utc: '2026-05-06T00:00:00.001Z',
      })
      expect(await tagRow('root')).toMatchObject({ deleted_at_utc: T1 })
      expect(
        JSON.parse((await db.exec('SELECT * FROM transactions'))[0]!.categories as string),
      ).toEqual([part('y')])
      expect(conflicts).toEqual([
        expect.objectContaining({ primaryKey: 'y', resolution: 'delete-undone', winner: 'local' }),
      ])
    })

    it('counts live transactions’ category parts only', async () => {
      await tag('target')
      await tag('merged', { mergedInto: 'target', deleted: T1 })
      await tag('usedByDeleted', { deleted: T1 })
      await tag('malformed', { deleted: T1 })
      // A plain tag is no category, though a live transaction uses it.
      await seedTag(db, {
        id: 'plain',
        name: 'plain',
        kind: 'tag',
        created: CUT,
        updated: T1,
        deleted: T1,
      })
      await txn('t1', { categories: [part('merged')], tags: ['plain'] })
      await txn('t2', { categories: [part('usedByDeleted')], deleted: T2 })
      await txn('t3', { categories: { category_id: 'malformed' } })
      await txn('t4', { categories: ['malformed'] })

      const conflicts = await repair(await side(), await side())

      // The merged category's part moved to its target; nothing was restored.
      expect(conflicts).toEqual([])
      const deleted = await db.exec<{ id: string }>(
        'SELECT id FROM tags WHERE deleted_at_utc IS NOT NULL ORDER BY id',
      )
      expect(deleted.map((r) => r.id)).toEqual(['malformed', 'merged', 'plain', 'usedByDeleted'])
    })
  })

  it('skips a malformed tags or categories value and leaves it unchanged', async () => {
    await tag('y')
    await tag('x', { mergedInto: 'y', deleted: T1 })
    await txn('good', { tags: ['x'], categories: [part('x')] })
    await txn('tagsObject', { tags: { first: 'x' } })
    await txn('categoriesObject', { categories: { category_id: 'x' } })
    await txn('categoriesOfText', { categories: ['x'] })
    await txn('partWithoutAmounts', { categories: [{ category_id: 'x' }] })

    await repair(await side(), await side())

    const rows = Object.fromEntries(
      (
        await db.exec<{ id: string; tags: string; categories: string }>(
          'SELECT id, tags, categories FROM transactions',
        )
      ).map((r) => [r.id, { tags: r.tags, categories: r.categories }]),
    )
    expect(rows.good).toEqual({ tags: '["y"]', categories: JSON.stringify([part('y')]) })
    expect(rows.tagsObject!.tags).toBe('{"first":"x"}')
    expect(rows.categoriesObject!.categories).toBe('{"category_id":"x"}')
    expect(rows.categoriesOfText!.categories).toBe('["x"]')
    expect(rows.partWithoutAmounts!.categories).toBe('[{"category_id":"x"}]')
  })
})
