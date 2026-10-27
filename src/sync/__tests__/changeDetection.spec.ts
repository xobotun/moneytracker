import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import { baseDetector, cutoffDetector } from '../changeDetection'
import { mergeDatabases, mergeTable } from '../mergeEngine'
import { readRows } from '../rows'
import {
  readSyncBase,
  readSyncBaseInfo,
  snapshotDatabase,
  writeSyncBase,
  type RowHashes,
} from '../syncBase'
import { newMigratedDb, nonEmpty, seedAccount, seedTag, seedTransaction } from './helpers'

const TAGS = { name: 'tags', pk: 'id' }
const SOURCE = { remoteId: 'memory', schemaVersion: 3 }

// The agreed rows are stamped T2. The one-sided edits below are stamped T1,
// earlier still (a slow clock, or a change made offline and uploaded late): a
// cutoff would call them unchanged, and latest-wins would drop them.
const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-02-01T00:00:00.000Z'
const T3 = '2026-03-01T00:00:00.000Z'
const T5 = '2026-05-01T00:00:00.000Z'

describe('merging by base hashes', () => {
  let dbs: Database[] = []
  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
  })

  /** Two devices that agree on `seed`, and the base of that agreed state. */
  async function agreed(
    seed: (db: Database) => Promise<void>,
  ): Promise<{ local: Database; remote: Database; base: RowHashes }> {
    const local = await newMigratedDb()
    const remote = await newMigratedDb()
    dbs.push(local, remote)
    await seed(local)
    await seed(remote)
    return { local, remote, base: (await snapshotDatabase(local)).rows }
  }

  const homeTag = (db: Database) =>
    seedTag(db, { id: 'home', name: 'Home', created: T2, updated: T2 })
  const deleteHome = (db: Database, at: string) =>
    db.run("UPDATE tags SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = 'home'", [at, at])
  const renameHome = (db: Database, at: string) =>
    db.run("UPDATE tags SET name = 'House', updated_at_utc = ? WHERE id = 'home'", [at])

  it('takes a row only the remote changed, though its stamps are older than the agreed row', async () => {
    const { local, remote, base } = await agreed(homeTag)
    await deleteHome(remote, T1)

    const conflicts = await mergeTable(local, remote, TAGS, baseDetector(base))

    expect(conflicts).toHaveLength(0)
    expect((await readRows(local, 'tags'))[0]!.deleted_at_utc).toBe(T1)
  })

  it('keeps a row only the local changed, though its stamps are older than the agreed row', async () => {
    const { local, remote, base } = await agreed(homeTag)
    await renameHome(local, T1)

    const conflicts = await mergeTable(local, remote, TAGS, baseDetector(base))

    expect(conflicts).toHaveLength(0)
    expect((await readRows(local, 'tags'))[0]!.name).toBe('House')
  })

  it('reports a row both sides changed, and lets an early delete win over a later edit', async () => {
    // The lost delete of docs/plans/2026-10-26-sync-change-detection.md §1.
    const { local, remote, base } = await agreed(homeTag)
    await deleteHome(remote, T1)
    await renameHome(local, T5)

    const conflicts = await mergeTable(local, remote, TAGS, baseDetector(base))

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!).toMatchObject({
      table: 'tags',
      primaryKey: 'home',
      winner: 'remote',
      resolution: 'delete-wins',
    })
    expect(conflicts[0]!.local.name).toBe('House')
    expect((await readRows(local, 'tags'))[0]!.deleted_at_utc).toBe(T1)
  })

  it('reports a row the base lacks when both sides hold it with different content', async () => {
    const { local, remote, base } = await agreed(async () => {})
    await seedTag(local, { id: 'new', name: 'Local', created: T3, updated: T3 })
    await seedTag(remote, { id: 'new', name: 'Remote', created: T3, updated: T5 })

    const conflicts = await mergeTable(local, remote, TAGS, baseDetector(base))

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!).toMatchObject({ primaryKey: 'new', resolution: 'latest-update-wins' })
    expect((await readRows(local, 'tags'))[0]!.name).toBe('Remote')
  })

  describe('two tombstones differing only in what their hash leaves out', () => {
    /**
     * Both devices agree that `x` (under `p1`) is deleted; one of them then
     * merged `p1` into `p2`, which moved the tombstone without a stamp.
     */
    async function tombstones(): Promise<{ moved: Database; kept: Database; base: RowHashes }> {
      const { local, remote, base } = await agreed(async (db) => {
        await seedTag(db, { id: 'p1', name: 'P1', created: T2, updated: T2 })
        await seedTag(db, { id: 'p2', name: 'P2', created: T2, updated: T2 })
        await seedTag(db, {
          id: 'x',
          name: 'X',
          created: T2,
          updated: T2,
          deleted: T2,
          parentId: 'p1',
        })
      })
      await local.run("UPDATE tags SET parent_id = 'p2' WHERE id = 'x'")
      return { moved: local, kept: remote, base }
    }

    const tombstoneIn = async (db: Database) =>
      (await readRows(db, 'tags')).find((row) => row.id === 'x')!

    it('settles them the same way on both devices, without a report', async () => {
      const onMover = await tombstones()
      const onOther = await tombstones()

      const moverConflicts = await mergeTable(
        onMover.moved,
        onMover.kept,
        TAGS,
        baseDetector(onMover.base),
      )
      const otherConflicts = await mergeTable(
        onOther.kept,
        onOther.moved,
        TAGS,
        baseDetector(onOther.base),
      )

      expect(moverConflicts).toHaveLength(0)
      expect(otherConflicts).toHaveLength(0)
      expect(await tombstoneIn(onOther.kept)).toEqual(await tombstoneIn(onMover.moved))
    })

    it('still reports them with a cutoff, which cannot tell that neither side changed', async () => {
      const { moved, kept } = await tombstones()

      const conflicts = await mergeTable(moved, kept, TAGS, cutoffDetector(T3))

      expect(conflicts).toHaveLength(1)
      expect(conflicts[0]!.primaryKey).toBe('x')
    })
  })

  describe('mergeDatabases with a source', () => {
    it('writes the remote’s rows as the new base', async () => {
      const { local, remote, base } = await agreed(homeTag)
      await seedTag(local, { id: 'mine', name: 'Mine', created: T3, updated: T3 })
      await seedAccount(remote, { id: 'acc', name: 'Cash', created: T3, updated: T3 })
      await renameHome(remote, T5)
      const expected = await snapshotDatabase(remote)

      await mergeDatabases(local, remote, baseDetector(base), SOURCE)

      expect(await readSyncBase(local)).toEqual(nonEmpty(expected.rows))
      expect(await readSyncBaseInfo(local)).toEqual({
        ...SOURCE,
        databaseHash: expected.databaseHash,
      })
    })

    it('leaves the base alone without a source', async () => {
      const { local, remote, base } = await agreed(homeTag)
      await seedTag(remote, { id: 'theirs', name: 'Theirs', created: T3, updated: T3 })

      await mergeDatabases(local, remote, baseDetector(base))

      expect((await readSyncBase(local)).size).toBe(0)
      expect(await readSyncBaseInfo(local)).toBeNull()
    })

    it('keeps the old base when the merge fails', async () => {
      const { local, remote, base } = await agreed(homeTag)
      const old = await snapshotDatabase(local)
      await local.transaction((tx) => writeSyncBase(tx, old, { remoteId: 'old', schemaVersion: 3 }))
      // A remote transaction whose account is missing: the merge fails when
      // its foreign keys are checked, at COMMIT.
      await seedAccount(remote, { id: 'acc-x', name: 'X', created: T3, updated: T3 })
      await seedTransaction(remote, { id: 'txn-x', accountFrom: 'acc-x', created: T3, updated: T3 })
      await remote.run('PRAGMA foreign_keys = OFF')
      await remote.run("DELETE FROM accounts WHERE id = 'acc-x'")
      await remote.run('PRAGMA foreign_keys = ON')

      await expect(mergeDatabases(local, remote, baseDetector(base), SOURCE)).rejects.toThrow()

      expect(await readSyncBase(local)).toEqual(nonEmpty(old.rows))
      expect(await readSyncBaseInfo(local)).toEqual({
        remoteId: 'old',
        schemaVersion: 3,
        databaseHash: old.databaseHash,
      })
    })
  })
})
