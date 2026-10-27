import { describe, it, expect, afterEach } from 'vitest'
import type { ShortId } from '../../../db/shortId'
import { at, minute, openPair, openTrio, settle, start, type Device, type World } from '../devices'
import { expectSound, openAccount, part, record, tagRow } from './fixtures'

// Tag merges (decisions §2.5) made on different devices while offline:
// chains, cycles over two and three devices, two targets for one source, and
// restores. Merged tags are deleted and remember their target; the repair
// after every merge undoes merge cycles and redirects references to the end
// of each merge chain.

describe('tag merges on several devices', () => {
  let world: World

  afterEach(async () => {
    await world.close()
  })

  /** The plain-tag ids of each live transaction. */
  const tagsOnTransactions = async (d: Device) => (await d.transactions.list()).map((t) => t.tags)

  // A merges X into Y (Y gets X's name as a synonym), B merges Y into Z (Z
  // gets Y's name). Delete wins on Y, so A's synonym edit of Y is dropped and
  // no live tag holds X's name "job" (§2.5: X's name and synonyms become
  // synonyms of the target). Sync does not rewrite synonyms; the lookup finds
  // the name on X's merged tombstone and follows the merge chain to Z.
  it('keeps every merged name findable along a merge chain made on two devices', async () => {
    const [a, b] = (world = await openPair()).devices
    let x!: ShortId, y!: ShortId, z!: ShortId
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'tag', name: 'job' })).id
      y = (await d.tags.create({ kind: 'tag', name: 'work' })).id
      z = (await d.tags.create({ kind: 'tag', name: 'employment' })).id
      const food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      const wallet = await openAccount(d, 'Wallet')
      await record(d, { from: wallet, to: null, parts: [part(food, 100)], tags: [x] })
    })
    at(minute(1))
    await a.tags.merge(x, y)
    at(minute(2))
    await b.tags.merge(y, z)
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync()

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await tagsOnTransactions(d)).toEqual([[z]])
      expect((await d.tags.findByName('tag', 'work'))?.id).toBe(z)
      expect((await d.tags.findByName('tag', 'job'))?.id).toBe(z)
    }
  })

  // The removal is stored on the live target (`retired_names`): edits to the
  // merged tag's own row would not sync, as a tombstone hashes by id and
  // delete time only.
  it('a removed merged name stops finding the tag on the other device too', async () => {
    const [a, b] = (world = await openPair()).devices
    let x!: ShortId, y!: ShortId
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'tag', name: 'job' })).id
      y = (await d.tags.create({ kind: 'tag', name: 'work' })).id
    })
    at(minute(1))
    await a.tags.merge(x, y)
    at(minute(2))
    await a.sync()
    await b.sync()
    expect((await b.tags.findByName('tag', 'job'))?.id).toBe(y)

    at(minute(3))
    const work = (await a.tags.findById(y))!
    await a.tags.save(y, {
      name: work.name,
      parent_id: null,
      description: null,
      otherNames: [],
      colour: null,
      icon: null,
      details: await a.details.values(y, 'tag'),
    })
    at(minute(4))
    await a.sync()
    await b.sync()

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect((await d.tags.findById(y))?.retired_names).toEqual(['job'])
      expect(await d.tags.findByName('tag', 'job')).toBeNull()
      expect((await d.tags.findByName('tag', 'work'))?.id).toBe(y)
    }
  })

  it('leaves one live tag of a merge cycle over three devices', async () => {
    const [a, b, c] = (world = await openTrio()).devices
    let x!: ShortId, y!: ShortId, z!: ShortId
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'tag', name: 'job' })).id
      y = (await d.tags.create({ kind: 'tag', name: 'work' })).id
      z = (await d.tags.create({ kind: 'tag', name: 'employment' })).id
      const food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      const wallet = await openAccount(d, 'Wallet')
      for (const tag of [x, y, z]) {
        await record(d, { from: wallet, to: null, parts: [part(food, 100)], tags: [tag] })
      }
    })
    at(minute(1))
    await a.tags.merge(x, y)
    at(minute(2))
    await b.tags.merge(y, z)
    at(minute(3))
    await c.tags.merge(z, x) // the latest merge: undone
    at(minute(4))
    await a.sync()
    at(minute(5))
    await b.sync()
    at(minute(6))
    const onC = await c.sync()
    expect(onC.conflicts.filter((k) => k.resolution === 'loop-undone')).toEqual([
      expect.objectContaining({ primaryKey: z }),
    ])

    await settle([a, b, c], 7)
    await expectSound([a, b, c])
    for (const d of [a, b, c]) {
      expect((await d.tags.list('tag')).map((t) => t.id)).toEqual([z])
      expect(await tagRow(d, x)).toMatchObject({ merged_into_id: y })
      expect(await tagRow(d, y)).toMatchObject({ merged_into_id: z })
      expect(await tagsOnTransactions(d)).toEqual([[z], [z], [z]])
    }
  })

  // The restore of a merge cycle carries A's rename of Y from minute 4. It is
  // stamped at the later of one millisecond after the cycle's latest change
  // (minute 2, B's merge) and the restored row's own time (minute 4), so C's
  // edit of minute 3 does not count as newer: the latest edit of Y, A's
  // rename, wins on every device.
  it('keeps a newer edit carried by a merge-cycle restore', async () => {
    const [a, b, c] = (world = await openTrio()).devices
    let x!: ShortId, y!: ShortId
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'tag', name: 'job' })).id
      y = (await d.tags.create({ kind: 'tag', name: 'work' })).id
    })
    at(minute(1))
    await a.tags.merge(x, y)
    at(minute(2))
    await b.tags.merge(y, x) // the later merge: undone, Y is restored as A has it
    at(minute(3))
    await c.tags.update(y, { description: 'from C' })
    at(minute(4))
    await a.tags.update(y, { name: 'labour' }) // the latest edit of Y
    at(minute(5))
    await b.sync()
    at(minute(6))
    await a.sync()
    expect(await tagRow(a, y)).toMatchObject({ name: 'labour', deleted_at_utc: null })
    at(minute(7))
    await c.sync()

    await settle([a, b, c], 8)
    await expectSound([a, b, c])
    for (const d of [a, b, c]) {
      expect(await tagRow(d, y)).toMatchObject({ name: 'labour', deleted_at_utc: null })
    }
  })

  it('follows the later of two merges of one tag into different targets', async () => {
    const [a, b] = (world = await openPair()).devices
    let x!: ShortId, y!: ShortId, z!: ShortId
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'tag', name: 'job' })).id
      y = (await d.tags.create({ kind: 'tag', name: 'work' })).id
      z = (await d.tags.create({ kind: 'tag', name: 'employment' })).id
      const food = (await d.tags.create({ kind: 'category', name: 'Food' })).id
      const wallet = await openAccount(d, 'Wallet')
      await record(d, { from: wallet, to: null, parts: [part(food, 100)], tags: [x] })
    })
    at(minute(1))
    await a.tags.merge(x, y)
    at(minute(2))
    await b.tags.merge(x, z) // the later merge decides where X went
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync()

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await tagRow(d, x)).toMatchObject({ merged_into_id: z })
      expect(await tagsOnTransactions(d)).toEqual([[z]])
      // Both targets took "job" as a synonym: shown as duplicates.
      expect(await d.tags.duplicates()).toEqual([[y, z].sort()])
    }
  })

  it('moves a child the other device added under the source to the target', async () => {
    const [a, b] = (world = await openPair()).devices
    let x!: ShortId, y!: ShortId
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'journey', name: 'Lisbon trip' })).id
      y = (await d.tags.create({ kind: 'journey', name: 'Summer 2026' })).id
    })
    at(minute(1))
    await a.tags.merge(x, y)
    at(minute(2))
    await b.tags.move(x, y) // B files the source under the target instead
    const k = (await b.tags.create({ kind: 'journey', name: 'Belém', parent_id: x })).id
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync()

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await tagRow(d, x)).toMatchObject({ merged_into_id: y })
      expect(await tagRow(d, k)).toMatchObject({ parent_id: y, deleted_at_utc: null })
    }
  })

  it('restores a merge cycle again after the other device brought its merged side back', async () => {
    // B uploads its merge (Y into X) early and then renames X. A meets the
    // cycle and restores Y; B's next merge sees A's merged X as older than
    // its cutoff and keeps its live X, so the cycle returns once more before
    // both devices settle on A's restore.
    const [a, b] = (world = await openPair()).devices
    let x!: ShortId, y!: ShortId
    await start(world, async (d) => {
      x = (await d.tags.create({ kind: 'tag', name: 'job' })).id
      y = (await d.tags.create({ kind: 'tag', name: 'work' })).id
    })
    at(minute(1))
    await a.tags.merge(x, y)
    at(minute(2))
    await b.tags.merge(y, x) // the later merge: undone
    at(minute(3))
    expect((await b.sync()).decision).toBe('upload-local')
    at(minute(5))
    await b.tags.update(x, { name: 'job 2' })
    at(minute(10))
    await a.tags.update(y, { name: 'labour' })
    at(minute(11))
    await a.sync()

    await settle([b, a], 12)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await tagRow(d, y)).toMatchObject({ name: 'labour', deleted_at_utc: null })
      expect(await tagRow(d, x)).toMatchObject({ merged_into_id: y })
    }
  })

  it('lifts a tag restored on one device whose parent the other device deleted', async () => {
    // The control for the bug below: a delete moves only live children, so
    // B's tombstone of X is not touched and A's restore stands.
    const [a, b] = (world = await openPair()).devices
    let p!: ShortId, x!: ShortId
    await start(world, async (d) => {
      p = (await d.tags.create({ kind: 'tag', name: 'home' })).id
      x = (await d.tags.create({ kind: 'tag', name: 'garden', parent_id: p })).id
      await d.tags.softDelete(x)
    })
    at(minute(1))
    await b.tags.softDelete(p)
    at(minute(2))
    await a.tags.restore(x) // under p: live on A
    at(minute(3))
    await a.sync()
    at(minute(4))
    await b.sync()

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await tagRow(d, x)).toMatchObject({ parent_id: null, deleted_at_utc: null })
    }
  })

  // X was deleted and synced long ago. A restores it (minute 2); B,
  // meanwhile, merges X's parent P into Q (minute 1), and the merge moves
  // X's tombstone under Q. Were the tombstone bumped, both rows would count
  // as changed since the cutoff and "delete wins" would drop A's restore —
  // although nobody deleted X concurrently. A merge bumps live rows only
  // (src/db/tagReferences.ts), so A's restore is the only change to X.
  it('keeps a restore when the other device merged the restored tag’s parent', async () => {
    const [a, b] = (world = await openPair()).devices
    let p!: ShortId, q!: ShortId, x!: ShortId
    await start(world, async (d) => {
      p = (await d.tags.create({ kind: 'tag', name: 'home' })).id
      q = (await d.tags.create({ kind: 'tag', name: 'house' })).id
      x = (await d.tags.create({ kind: 'tag', name: 'garden', parent_id: p })).id
      await d.tags.softDelete(x)
    })
    at(minute(1))
    await b.tags.merge(p, q)
    at(minute(2))
    await a.tags.restore(x)
    at(minute(3))
    const onA = await a.sync()
    at(minute(4))
    const onB = await b.sync()

    await settle([a, b], 5)
    await expectSound([a, b])
    for (const d of [a, b]) {
      expect(await tagRow(d, x)).toMatchObject({ parent_id: q, deleted_at_utc: null })
    }
    // The merge moved x's tombstone without a stamp, which is no change to it:
    // only the restore changed x.
    expect([...onA.conflicts, ...onB.conflicts].filter((c) => c.primaryKey === x)).toEqual([])
  })
})
