import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
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

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

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

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

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

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

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

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

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

    await expect(mergeDatabases(local, remote, CUTOFF)).rejects.toThrow()
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

    const merge = mergeDatabases(local, remote, CUTOFF)
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

      const conflicts = await mergeDatabases(local, remote, CUTOFF)

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

      const conflicts = await mergeDatabases(local, remote, CUTOFF)

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

      await mergeDatabases(local, remote, CUTOFF)

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

      const conflicts = await mergeDatabases(local, remote, CUTOFF)

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

      await mergeDatabases(local, remote, CUTOFF)

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

    await mergeDatabases(local, remote, CUTOFF)

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

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

    expect(conflicts).toHaveLength(0)
    const [account] = await readRows(local, 'accounts')
    expect(account).toMatchObject({ balance_value: -100, balance_scale: 2, updated_at_utc: CUTOFF })
  })
})
