import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import { mergeDatabases } from '../mergeEngine'
import { readRows } from '../rows'
import { ExchangeRatesRepository } from '../../db/repositories/ExchangeRatesRepository'
import { newMigratedDb, seedLocation, seedAccount, seedTransaction } from './helpers'

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
    await seedLocation(remote, { id: 'loc-1', name: 'Bank HQ', created: CUTOFF, updated: CUTOFF })
    await seedAccount(remote, {
      id: 'acc-1',
      name: 'Checking',
      created: CUTOFF,
      updated: CUTOFF,
      locationId: 'loc-1',
    })

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

    expect(conflicts).toHaveLength(0)
    expect(await readRows(local, 'locations')).toHaveLength(1)
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
    await seedLocation(local, { id: 'l', name: 'L-local', created: CUTOFF, updated: '2026-05-05T00:00:00.000Z' })
    await seedLocation(remote, { id: 'l', name: 'L-remote', created: CUTOFF, updated: '2026-05-06T00:00:00.000Z' })
    await seedAccount(local, { id: 'a', name: 'A-local', created: CUTOFF, updated: '2026-05-05T00:00:00.000Z' })
    await seedAccount(remote, { id: 'a', name: 'A-remote', created: CUTOFF, updated: '2026-05-06T00:00:00.000Z' })

    const conflicts = await mergeDatabases(local, remote, CUTOFF)

    expect(conflicts.map((c) => c.table).sort()).toEqual(['accounts', 'locations'])
  })

  it('captures both local and remote snapshots on every conflict', async () => {
    // The conflict email (deferred) needs the loser's data. Lock in that
    // mergeDatabases stashes both row versions, not just the winner.
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, {
      id: 'snap',
      name: 'Local snapshot',
      created: CUTOFF,
      updated: '2026-05-05T00:00:00.000Z',
    })
    await seedLocation(remote, {
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
    await seedLocation(remote, { id: 'ok', name: 'Fine', created: CUTOFF, updated: CUTOFF })
    // Build a remote whose transaction references a missing account. The
    // straightforward `DELETE FROM accounts` would itself fail under
    // PRAGMA foreign_keys = ON (set by Database.init) because the transaction
    // restricts it; toggle FK off around the delete to construct the
    // inconsistent state on purpose, then turn FK back on so the merge
    // really exercises the enforcement path on the local side.
    await seedAccount(remote, { id: 'acc-x', name: 'X', created: CUTOFF, updated: CUTOFF })
    await seedTransaction(remote, { id: 'txn-x', accountFrom: 'acc-x', created: CUTOFF, updated: CUTOFF })
    await remote.run('PRAGMA foreign_keys = OFF')
    await remote.run('DELETE FROM accounts WHERE id = ?', ['acc-x'])
    await remote.run('PRAGMA foreign_keys = ON')

    await expect(mergeDatabases(local, remote, CUTOFF)).rejects.toThrow()
    // The earlier, successful location upsert must have been rolled back.
    expect(await readRows(local, 'locations')).toHaveLength(0)
  })

  it('does not swallow an app write made while a failing merge is in flight', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    // Same broken remote as above: the merge fails on the transaction's FK.
    await seedLocation(remote, { id: 'ok', name: 'Fine', created: CUTOFF, updated: CUTOFF })
    await seedAccount(remote, { id: 'acc-x', name: 'X', created: CUTOFF, updated: CUTOFF })
    await seedTransaction(remote, { id: 'txn-x', accountFrom: 'acc-x', created: CUTOFF, updated: CUTOFF })
    await remote.run('PRAGMA foreign_keys = OFF')
    await remote.run('DELETE FROM accounts WHERE id = ?', ['acc-x'])
    await remote.run('PRAGMA foreign_keys = ON')

    const merge = mergeDatabases(local, remote, CUTOFF)
    // The user saves something while the sync runs.
    const appWrite = seedLocation(local, { id: 'user-edit', name: 'Mine', created: CUTOFF, updated: CUTOFF })

    await expect(merge).rejects.toThrow()
    await appWrite
    const ids = (await readRows(local, 'locations')).map((r) => r.id)
    expect(ids).toEqual(['user-edit'])
  })

  it('merges the same exchange rate fetched on two devices into one row', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    const key = { date: '2026-05-20', base_currency: 'USD', provider: 'openexchangerates' }
    await new ExchangeRatesRepository(local).create({ ...key, rates: { EUR: 0.92 } })
    await new ExchangeRatesRepository(remote).create({ ...key, rates: { EUR: 0.93 } })

    await mergeDatabases(local, remote, CUTOFF)

    expect(await readRows(local, 'exchange_rates')).toHaveLength(1)
  })
})
