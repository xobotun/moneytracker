import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import { mergeTable } from '../mergeEngine'
import { readRows } from '../rows'
import { newMigratedDb, seedLocation } from './helpers'

const LOCATIONS = { name: 'locations', pk: 'id' }
const CUTOFF = '2026-05-01T00:00:00.000Z'

describe('mergeTable', () => {
  let local: Database
  let remote: Database

  afterEach(async () => {
    if (local) await local.close()
    if (remote) await remote.close()
  })

  it('keeps a row that exists only locally', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, { id: 'a', name: 'Local only', created: CUTOFF, updated: CUTOFF })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
    expect(await readRows(local, 'locations')).toHaveLength(1)
  })

  it('inserts a row that exists only remotely', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(remote, { id: 'b', name: 'Remote only', created: CUTOFF, updated: CUTOFF })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
    const rows = await readRows(local, 'locations')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Remote only')
  })

  it('takes the remote version when only the remote changed since the cutoff', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, { id: 'c', name: 'Old', created: CUTOFF, updated: CUTOFF })
    await seedLocation(remote, {
      id: 'c',
      name: 'New from remote',
      created: CUTOFF,
      updated: '2026-05-10T00:00:00.000Z',
    })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
    expect((await readRows(local, 'locations'))[0]!.name).toBe('New from remote')
  })

  it('keeps the local version when only the local changed since the cutoff', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, {
      id: 'd',
      name: 'New from local',
      created: CUTOFF,
      updated: '2026-05-10T00:00:00.000Z',
    })
    await seedLocation(remote, { id: 'd', name: 'Old', created: CUTOFF, updated: CUTOFF })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
    expect((await readRows(local, 'locations'))[0]!.name).toBe('New from local')
  })

  it('reports a conflict and applies the winner when both sides changed', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, {
      id: 'e',
      name: 'Local edit',
      created: CUTOFF,
      updated: '2026-05-05T00:00:00.000Z',
    })
    await seedLocation(remote, {
      id: 'e',
      name: 'Remote edit',
      created: CUTOFF,
      updated: '2026-05-08T00:00:00.000Z', // newer → remote wins
    })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!).toMatchObject({ table: 'locations', primaryKey: 'e', winner: 'remote' })
    expect((await readRows(local, 'locations'))[0]!.name).toBe('Remote edit')
  })

  it('does not report a conflict when both sides hold an identical row', async () => {
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, { id: 'f', name: 'Same', created: CUTOFF, updated: CUTOFF })
    await seedLocation(remote, { id: 'f', name: 'Same', created: CUTOFF, updated: CUTOFF })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
  })

  it('propagates a remote soft-delete onto an unchanged local row', async () => {
    // One-sided delete: remote deleted, local untouched. Not a conflict —
    // the delete is just a "remote changed" upsert that brings the tombstone over.
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, { id: 'g', name: 'Doomed', created: CUTOFF, updated: CUTOFF })
    await seedLocation(remote, {
      id: 'g',
      name: 'Doomed',
      created: CUTOFF,
      updated: '2026-05-10T00:00:00.000Z',
      deleted: '2026-05-10T00:00:00.000Z',
    })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(0)
    const rows = await readRows(local, 'locations')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.deleted_at_utc).toBe('2026-05-10T00:00:00.000Z')
  })

  it('lets a delete win over a concurrent edit even when the edit is newer', async () => {
    // Both sides changed: local edited later than the remote delete. The
    // delete-wins rule overrides "latest timestamp wins", so the tombstone lands.
    local = await newMigratedDb()
    remote = await newMigratedDb()
    await seedLocation(local, {
      id: 'h',
      name: 'Edited locally',
      created: CUTOFF,
      updated: '2026-05-09T00:00:00.000Z',
    })
    await seedLocation(remote, {
      id: 'h',
      name: 'About to be deleted',
      created: CUTOFF,
      updated: '2026-05-05T00:00:00.000Z',
      deleted: '2026-05-05T00:00:00.000Z',
    })

    const conflicts = await mergeTable(local, remote, LOCATIONS, CUTOFF)

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!).toMatchObject({
      table: 'locations',
      primaryKey: 'h',
      winner: 'remote',
      resolution: 'delete-wins',
    })
    expect((await readRows(local, 'locations'))[0]!.deleted_at_utc).toBe('2026-05-05T00:00:00.000Z')
  })
})
