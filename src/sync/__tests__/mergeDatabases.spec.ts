import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { Database } from '../../db/Database'
import { cutoffDetector } from '../changeDetection'
import { mergeDatabases } from '../mergeEngine'
import { readRows } from '../rows'
import { ExchangeRatesRepository } from '../../db/repositories/ExchangeRatesRepository'
import { AppliedRatesRepository } from '../../db/repositories/AppliedRatesRepository'
import { hashDatabase } from '../hashDatabase'
import { newMigratedDb, seedTag, seedAccount, seedTransaction } from './helpers'

const CUTOFF = '2026-05-01T00:00:00.000Z'

describe('mergeDatabases', () => {
  let local: Database
  let remote: Database

  afterEach(async () => {
    if (local) await local.close()
    if (remote) await remote.close()
  })

  it('merges a remote-only account together with the location it references', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    // Parent before child within the remote: location must merge before the account
    // that references it, or the foreign key would fail.
    await seedTag(remote, { id: 'loc-1', name: 'Bank HQ', created: CUTOFF, updated: CUTOFF })
    await seedAccount(remote, {
      id: 'acc-1',
      name: 'Checking',
      created: CUTOFF,
      updated: CUTOFF,
      locationId: 'loc-1',
    })

    const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

    expect(conflicts).toHaveLength(0)
    expect(await readRows(local, 'tags')).toHaveLength(1)
    expect(await readRows(local, 'accounts')).toHaveLength(1)
  })

  it('merges a remote-only transaction together with its account', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedAccount(remote, { id: 'acc-2', name: 'Cash', created: CUTOFF, updated: CUTOFF })
    await seedTransaction(remote, {
      id: 'txn-1',
      accountFrom: 'acc-2',
      created: CUTOFF,
      updated: CUTOFF,
    })

    const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

    expect(conflicts).toHaveLength(0)
    expect(await readRows(local, 'transactions')).toHaveLength(1)
  })

  it('aggregates conflicts across multiple tables', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedTag(local, {
      id: 'l',
      name: 'L-local',
      created: CUTOFF,
      updated: '2026-05-05T00:00:00.000Z',
    })
    await seedTag(remote, {
      id: 'l',
      name: 'L-remote',
      created: CUTOFF,
      updated: '2026-05-06T00:00:00.000Z',
    })
    await seedAccount(local, {
      id: 'a',
      name: 'A-local',
      created: CUTOFF,
      updated: '2026-05-05T00:00:00.000Z',
    })
    await seedAccount(remote, {
      id: 'a',
      name: 'A-remote',
      created: CUTOFF,
      updated: '2026-05-06T00:00:00.000Z',
    })

    const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

    expect(conflicts.map((c) => c.table).sort()).toEqual(['accounts', 'tags'])
  })

  it('captures both local and remote snapshots on every conflict', async () => {
    // The conflict email (deferred) needs the loser's data. Lock in that
    // mergeDatabases stashes both row versions, not just the winner.
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedTag(local, {
      id: 'snap',
      name: 'Local snapshot',
      created: CUTOFF,
      updated: '2026-05-05T00:00:00.000Z',
    })
    await seedTag(remote, {
      id: 'snap',
      name: 'Remote snapshot',
      created: CUTOFF,
      updated: '2026-05-06T00:00:00.000Z',
    })

    const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

    expect(conflicts).toHaveLength(1)
    const c = conflicts[0]!
    expect(c.local.name).toBe('Local snapshot')
    expect(c.remote.name).toBe('Remote snapshot')
    expect(c.winner).toBe('remote')
    expect(c.resolution).toBe('latest-update-wins')
  })

  it('rolls back the local database when a merge step fails', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedTag(remote, { id: 'ok', name: 'Fine', created: CUTOFF, updated: CUTOFF })
    // Build a remote whose transaction references a missing account. The
    // straightforward `DELETE FROM accounts` would itself fail under
    // PRAGMA foreign_keys = ON (set by Database.init) because the transaction
    // restricts it; toggle FK off around the delete to construct the
    // inconsistent state on purpose, then turn FK back on so the merge
    // really exercises the enforcement path on the local side.
    await seedAccount(remote, { id: 'acc-x', name: 'X', created: CUTOFF, updated: CUTOFF })
    await seedTransaction(remote, {
      id: 'txn-x',
      accountFrom: 'acc-x',
      created: CUTOFF,
      updated: CUTOFF,
    })
    await remote.run('PRAGMA foreign_keys = OFF')
    await remote.run('DELETE FROM accounts WHERE id = ?', ['acc-x'])
    await remote.run('PRAGMA foreign_keys = ON')

    await expect(mergeDatabases(local, remote, cutoffDetector(CUTOFF))).rejects.toThrow()
    // The earlier, successful location upsert must have been rolled back.
    expect(await readRows(local, 'tags')).toHaveLength(0)
  })

  it('does not swallow an app write made while a failing merge is in flight', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    // Same broken remote as above: the merge fails on the transaction's FK.
    await seedTag(remote, { id: 'ok', name: 'Fine', created: CUTOFF, updated: CUTOFF })
    await seedAccount(remote, { id: 'acc-x', name: 'X', created: CUTOFF, updated: CUTOFF })
    await seedTransaction(remote, {
      id: 'txn-x',
      accountFrom: 'acc-x',
      created: CUTOFF,
      updated: CUTOFF,
    })
    await remote.run('PRAGMA foreign_keys = OFF')
    await remote.run('DELETE FROM accounts WHERE id = ?', ['acc-x'])
    await remote.run('PRAGMA foreign_keys = ON')

    const merge = mergeDatabases(local, remote, cutoffDetector(CUTOFF))
    // The user saves something while the sync runs.
    const appWrite = seedTag(local, {
      id: 'user-edit',
      name: 'Mine',
      created: CUTOFF,
      updated: CUTOFF,
    })

    await expect(merge).rejects.toThrow()
    await appWrite
    const ids = (await readRows(local, 'tags')).map((r) => r.id)
    expect(ids).toEqual(['user-edit'])
  })

  describe('applied rates', () => {
    const D = '2026-10-20'
    const DIRECT = { rate: 1.1, provider: 'fawazahmed0', via: null, referenceDate: D }
    const later = () => new Promise((r) => setTimeout(r, 5))

    it('merges the same rate resolved on two devices into one row, without a conflict', async () => {
      local = await newMigratedDb()
      remote = await newMigratedDb()
      await new AppliedRatesRepository(local).saveAuto({
        date: D,
        x: 'EUR',
        y: 'USD',
        resolution: DIRECT,
      })
      await later()
      await new AppliedRatesRepository(remote).saveAuto({
        date: D,
        x: 'EUR',
        y: 'USD',
        resolution: DIRECT,
      })

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(conflicts).toEqual([])
      expect(await readRows(local, 'applied_rates')).toHaveLength(1)
      expect(await hashDatabase(local)).toBe(await hashDatabase(remote))
    })

    it('keeps an override over a newer resolved rate from the other device', async () => {
      local = await newMigratedDb()
      remote = await newMigratedDb()
      await new AppliedRatesRepository(local).setManual(D, 'EUR', 'USD', 1.5)
      await later()
      await new AppliedRatesRepository(remote).saveAuto({
        date: D,
        x: 'EUR',
        y: 'USD',
        resolution: DIRECT,
      })

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(conflicts.map((c) => c.resolution)).toEqual(['rank-wins'])
      expect(await new AppliedRatesRepository(local).find(D, 'EUR', 'USD')).toMatchObject({
        rate: 1.5,
        provider: 'manual',
      })
    })

    it('takes the other device’s override over a newer local resolved rate', async () => {
      local = await newMigratedDb()
      remote = await newMigratedDb()
      await new AppliedRatesRepository(remote).setManual(D, 'EUR', 'USD', 1.5)
      await later()
      await new AppliedRatesRepository(local).saveAuto({
        date: D,
        x: 'EUR',
        y: 'USD',
        resolution: DIRECT,
      })

      await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(await new AppliedRatesRepository(local).find(D, 'EUR', 'USD')).toMatchObject({
        provider: 'manual',
      })
    })

    it('keeps a central bank’s cross rate over a newer aggregator’s direct one', async () => {
      local = await newMigratedDb()
      remote = await newMigratedDb()
      const bankCross = { rate: 1.12, provider: 'ecb+nbk', via: 'KZT', referenceDate: D }
      await new AppliedRatesRepository(local).saveAuto({
        date: D,
        x: 'EUR',
        y: 'USD',
        resolution: bankCross,
      })
      await later()
      await new AppliedRatesRepository(remote).saveAuto({
        date: D,
        x: 'EUR',
        y: 'USD',
        resolution: DIRECT,
      })

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(conflicts.map((c) => c.resolution)).toEqual(['rank-wins'])
      expect((await new AppliedRatesRepository(local).find(D, 'EUR', 'USD'))!.provider).toBe(
        'ecb+nbk',
      )
    })

    it('keeps a found rate over a newer empty row', async () => {
      local = await newMigratedDb()
      remote = await newMigratedDb()
      await new AppliedRatesRepository(local).saveAuto({
        date: D,
        x: 'EUR',
        y: 'USD',
        resolution: DIRECT,
      })
      await later()
      await new AppliedRatesRepository(remote).saveAuto({
        date: D,
        x: 'EUR',
        y: 'USD',
        resolution: null,
      })

      await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect((await new AppliedRatesRepository(local).find(D, 'EUR', 'USD'))!.rate).toBe(1.1)
    })
  })

  it('leaves the device-local exchange_rates library alone', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await new ExchangeRatesRepository(remote).save({
      date: '2026-10-20',
      base_currency: 'EUR',
      provider: 'fawazahmed0',
      rates: { USD: 1.1 },
    })

    await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

    expect(await readRows(local, 'exchange_rates')).toHaveLength(0)
  })

  it('rebuilds the cached balances from the merged transactions', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedAccount(local, { id: 'acc-9', name: 'Cash', created: CUTOFF, updated: CUTOFF })
    await seedAccount(remote, { id: 'acc-9', name: 'Cash', created: CUTOFF, updated: CUTOFF })
    // The remote spent 1.00 USD from it; the local cache has not seen that.
    await seedTransaction(remote, {
      id: 'txn-9',
      accountFrom: 'acc-9',
      created: CUTOFF,
      updated: CUTOFF,
    })
    await remote.run("UPDATE accounts SET balance_value = -100 WHERE id = 'acc-9'")

    const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

    expect(conflicts).toHaveLength(0)
    const [account] = await readRows(local, 'accounts')
    expect(account).toMatchObject({ balance_value: -100, balance_scale: 2, updated_at_utc: CUTOFF })
  })

  describe('tag repairs', () => {
    const T1 = '2026-05-05T00:00:00.000Z'
    const T2 = '2026-05-06T00:00:00.000Z'

    beforeEach(async () => {
      local = await newMigratedDb()
      remote = await newMigratedDb()
    })

    /** Seeds the same rows on both devices: the state they last synced. */
    async function common(seed: (db: Database) => Promise<void>): Promise<void> {
      await seed(local)
      await seed(remote)
    }

    /** What `TagsRepository.merge` leaves on the source row. */
    async function mergeInto(db: Database, from: string, to: string, at: string): Promise<void> {
      await db.run(
        'UPDATE tags SET merged_into_id = ?, deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?',
        [to, at, at, from],
      )
    }

    /** What `TagsRepository.move` leaves on the row. */
    async function move(db: Database, id: string, parentId: string | null, at: string) {
      await db.run(
        'UPDATE tags SET parent_id = ?, moved_at_utc = ?, updated_at_utc = ? WHERE id = ?',
        [parentId, at, at, id],
      )
    }

    const rowOf = async (table: string, id: string) =>
      (await local.exec(`SELECT * FROM ${table} WHERE id = ?`, [id]))[0]!

    it('merges a child tag that sorts before its parent', async () => {
      // The remote holds the child first, as a CSV import in id order leaves
      // it, so the merge meets the child before its parent.
      await remote.transaction(async (tx) => {
        await tx.run('PRAGMA defer_foreign_keys = ON')
        await seedTag(tx, {
          id: 'a-child',
          name: 'Fruit',
          kind: 'category',
          parentId: 'b-parent',
          created: T1,
          updated: T1,
        })
        await seedTag(tx, {
          id: 'b-parent',
          name: 'Food',
          kind: 'category',
          created: T1,
          updated: T1,
        })
      })

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(conflicts).toEqual([])
      expect(await rowOf('tags', 'a-child')).toMatchObject({ parent_id: 'b-parent' })
    })

    it('keeps duplicate tag names from two devices', async () => {
      await seedTag(local, {
        id: 'rewe-local',
        name: 'Rewe',
        kind: 'merchant',
        created: T1,
        updated: T1,
      })
      await seedTag(remote, {
        id: 'rewe-remote',
        name: 'Rewe',
        kind: 'merchant',
        created: T2,
        updated: T2,
      })

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(conflicts).toEqual([])
      const live = await local.exec<{ id: string }>(
        "SELECT id FROM tags WHERE name = 'Rewe' AND deleted_at_utc IS NULL ORDER BY id",
      )
      expect(live.map((r) => r.id)).toEqual(['rewe-local', 'rewe-remote'])
    })

    it('redirects references to a tag merged on another device', async () => {
      await common(async (db) => {
        await seedTag(db, { id: 'x', name: 'job', kind: 'tag', created: CUTOFF, updated: CUTOFF })
        await seedTag(db, { id: 'y', name: 'work', kind: 'tag', created: CUTOFF, updated: CUTOFF })
        await seedAccount(db, { id: 'acc', name: 'Wallet', created: CUTOFF, updated: CUTOFF })
      })
      // Offline, this device tags the account and a new transaction with X…
      await local.run(`UPDATE accounts SET tags = '["x"]', updated_at_utc = ? WHERE id = 'acc'`, [
        T1,
      ])
      await seedTransaction(local, {
        id: 'txn',
        accountFrom: 'acc',
        tags: ['x'],
        created: T1,
        updated: T1,
      })
      // …while the other device merges X into Y.
      await mergeInto(remote, 'x', 'y', T2)

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(conflicts).toEqual([])
      expect(await rowOf('transactions', 'txn')).toMatchObject({
        tags: '["y"]',
        updated_at_utc: T1,
      })
      expect(await rowOf('accounts', 'acc')).toMatchObject({ tags: '["y"]', updated_at_utc: T1 })
    })

    it('follows a merge chain to its end', async () => {
      // X merged into Y on this device, Y into Z on the other: a chain, not a cycle.
      await common(async (db) => {
        for (const id of ['x', 'y', 'z']) {
          await seedTag(db, { id, name: id, kind: 'tag', created: CUTOFF, updated: CUTOFF })
        }
        await seedAccount(db, { id: 'acc', name: 'Wallet', created: CUTOFF, updated: CUTOFF })
      })
      await mergeInto(local, 'x', 'y', T1)
      await mergeInto(remote, 'y', 'z', T2)
      // The other device used X before it learned of any merge.
      await seedTransaction(remote, {
        id: 'txn',
        accountFrom: 'acc',
        tags: ['x'],
        created: T2,
        updated: T2,
      })

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(conflicts).toEqual([])
      expect(await rowOf('transactions', 'txn')).toMatchObject({ tags: '["z"]' })
      // The chain itself is history and stays.
      expect(await rowOf('tags', 'x')).toMatchObject({ merged_into_id: 'y' })
      expect(await rowOf('tags', 'y')).toMatchObject({ merged_into_id: 'z' })
    })

    it('undoes the later merge of a merge cycle', async () => {
      await common(async (db) => {
        await seedTag(db, { id: 'x', name: 'job', kind: 'tag', created: CUTOFF, updated: CUTOFF })
        await seedTag(db, { id: 'y', name: 'work', kind: 'tag', created: CUTOFF, updated: CUTOFF })
        await seedAccount(db, { id: 'acc', name: 'Wallet', created: CUTOFF, updated: CUTOFF })
      })
      // This device merges X into Y; the other one, later, tags a transaction
      // with X and merges Y into X.
      await mergeInto(local, 'x', 'y', T1)
      await seedTransaction(remote, {
        id: 'txn',
        accountFrom: 'acc',
        tags: ['x'],
        created: T2,
        updated: T2,
      })
      await mergeInto(remote, 'y', 'x', T2)

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      // The earlier merge stands: Y is back, and X stays merged into it.
      expect(await rowOf('tags', 'y')).toMatchObject({
        deleted_at_utc: null,
        merged_into_id: null,
        updated_at_utc: '2026-05-06T00:00:00.001Z', // the later merge's time + 1 ms
      })
      expect(await rowOf('tags', 'x')).toMatchObject({ merged_into_id: 'y', deleted_at_utc: T1 })
      expect(await rowOf('transactions', 'txn')).toMatchObject({
        tags: '["y"]',
        updated_at_utc: T2,
      })
      expect(conflicts).toEqual([
        expect.objectContaining({
          table: 'tags',
          primaryKey: 'y',
          resolution: 'loop-undone',
          winner: 'local',
          local: expect.objectContaining({ merged_into_id: null }),
          remote: expect.objectContaining({ merged_into_id: 'x' }),
        }),
      ])
    })

    it('lifts a tag whose parent was deleted on another device', async () => {
      await common(async (db) => {
        await seedTag(db, {
          id: 'food',
          name: 'Food',
          kind: 'category',
          created: CUTOFF,
          updated: CUTOFF,
        })
        await seedTag(db, {
          id: 'fruit',
          name: 'Fruit',
          kind: 'category',
          parentId: 'food',
          created: CUTOFF,
          updated: CUTOFF,
        })
      })
      await seedTag(local, {
        id: 'apples',
        name: 'Apples',
        kind: 'category',
        parentId: 'fruit',
        created: T1,
        updated: T1,
      })
      await remote.run(
        "UPDATE tags SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = 'fruit'",
        [T2, T2],
      )

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(conflicts).toEqual([])
      expect(await rowOf('tags', 'apples')).toMatchObject({ parent_id: 'food', updated_at_utc: T1 })
    })

    it('lifts a tag whose parent was merged into it on another device', async () => {
      // One device merges X into Y; the other, later, moves Y under X. Y cannot
      // be its own parent, so it goes to X's nearest live ancestor.
      await common(async (db) => {
        await seedTag(db, { id: 'g', name: 'G', kind: 'tag', created: CUTOFF, updated: CUTOFF })
        await seedTag(db, {
          id: 'x',
          name: 'X',
          kind: 'tag',
          parentId: 'g',
          created: CUTOFF,
          updated: CUTOFF,
        })
        await seedTag(db, { id: 'y', name: 'Y', kind: 'tag', created: CUTOFF, updated: CUTOFF })
      })
      await mergeInto(remote, 'x', 'y', T1)
      await move(local, 'y', 'x', T2)

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(conflicts).toEqual([])
      expect(await rowOf('tags', 'y')).toMatchObject({ parent_id: 'g', updated_at_utc: T2 })
    })

    it('undoes the later move of a parent loop', async () => {
      await common(async (db) => {
        await seedTag(db, {
          id: 'p',
          name: 'P',
          kind: 'category',
          created: CUTOFF,
          updated: CUTOFF,
        })
        await seedTag(db, {
          id: 'a',
          name: 'A',
          kind: 'category',
          created: CUTOFF,
          updated: CUTOFF,
        })
        await seedTag(db, {
          id: 'b',
          name: 'B',
          kind: 'category',
          parentId: 'p',
          created: CUTOFF,
          updated: CUTOFF,
        })
      })
      // This device moves A under B; the other one, later, moves B under A.
      await move(local, 'a', 'b', T1)
      await move(remote, 'b', 'a', T2)

      const conflicts = await mergeDatabases(local, remote, cutoffDetector(CUTOFF))

      expect(await rowOf('tags', 'a')).toMatchObject({ parent_id: 'b', updated_at_utc: T1 })
      // B goes back to its parent on this device, not to the top level.
      const b = await rowOf('tags', 'b')
      expect(b.parent_id).toBe('p')
      expect((b.updated_at_utc as string) > T2).toBe(true)
      expect(conflicts).toEqual([
        expect.objectContaining({
          table: 'tags',
          primaryKey: 'b',
          resolution: 'loop-undone',
          winner: 'local',
          local: expect.objectContaining({ parent_id: 'p' }),
          remote: expect.objectContaining({ parent_id: 'a' }),
        }),
      ])
    })
  })
})
