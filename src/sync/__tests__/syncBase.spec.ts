import { describe, it, expect, afterEach } from 'vitest'
import type { Database } from '../../db/Database'
import { hashDatabase, __resetHashCache } from '../hashDatabase'
import {
  rowHash,
  snapshotDatabase,
  readSyncBase,
  readSyncBaseInfo,
  writeSyncBase,
  type Snapshot,
} from '../syncBase'
import { SYNC_TABLES } from '../syncTables'
import type { SyncRow } from '../types'
import { newMigratedDb, seedTag, seedAccount } from './helpers'

const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-02-01T00:00:00.000Z'
const T3 = '2026-03-01T00:00:00.000Z'

const table = (name: string) => SYNC_TABLES.find((t) => t.name === name)!

const liveTag: SyncRow = {
  id: 'tag000000001',
  kind: 'location',
  name: 'Home',
  parent_id: null,
  moved_at_utc: T1,
  description: null,
  synonyms: '[]',
  colour: null,
  icon: null,
  merged_into_id: null,
  created_at_utc: T1,
  updated_at_utc: T1,
  deleted_at_utc: null,
}

describe('rowHash', () => {
  it('is 32 lower-case hex characters, equal for equal rows', async () => {
    const a = await rowHash(table('tags'), liveTag)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(await rowHash(table('tags'), { ...liveTag })).toBe(a)
  })

  it('differs when any hashed column differs', async () => {
    const base = await rowHash(table('tags'), liveTag)
    for (const [key, value] of [
      ['name', 'Work'],
      ['parent_id', 'tag000000002'],
      ['updated_at_utc', T2],
      ['synonyms', '["x"]'],
    ] as const) {
      expect(await rowHash(table('tags'), { ...liveTag, [key]: value })).not.toBe(base)
    }
  })

  it('ignores the columns the merge ignores', async () => {
    const account: SyncRow = {
      id: 'acc000000001',
      name: 'Cash',
      balance_value: 100,
      balance_scale: 2,
    }
    const before = await rowHash(table('accounts'), account)
    expect(await rowHash(table('accounts'), { ...account, balance_value: 5 })).toBe(before)
    const rate: SyncRow = {
      id: 'r1',
      rate: 1.5,
      created_at_utc: T1,
      updated_at_utc: T1,
      deleted_at_utc: null,
    }
    expect(await rowHash(table('applied_rates'), { ...rate, updated_at_utc: T3 })).toBe(
      await rowHash(table('applied_rates'), rate),
    )
  })

  it('hashes a deleted row by identity and delete time only', async () => {
    const dead: SyncRow = { ...liveTag, deleted_at_utc: T2, updated_at_utc: T2 }
    const h = await rowHash(table('tags'), dead)
    expect(
      await rowHash(table('tags'), { ...dead, parent_id: 'tag000000009', name: 'Other' }),
    ).toBe(h)
    expect(await rowHash(table('tags'), { ...dead, deleted_at_utc: T3 })).not.toBe(h)
    expect(await rowHash(table('tags'), { ...dead, deleted_at_utc: null })).not.toBe(h)
    expect(await rowHash(table('tags'), liveTag)).not.toBe(h)
  })
})

describe('sync base', () => {
  let dbs: Database[] = []
  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
    __resetHashCache()
  })
  async function open(): Promise<Database> {
    const db = await newMigratedDb()
    dbs.push(db)
    return db
  }

  it('snapshotDatabase hashes like hashDatabase, with a hash per row', async () => {
    const db = await open()
    __resetHashCache()
    await seedTag(db, { id: 'tag000000001', name: 'Home', created: T1, updated: T1 })
    await seedTag(db, { id: 'tag000000002', name: 'Gone', created: T1, updated: T2, deleted: T2 })
    await seedAccount(db, { id: 'acc000000001', name: 'Cash', created: T1, updated: T1 })
    const snap = await snapshotDatabase(db)
    expect(snap.databaseHash).toBe(await hashDatabase(db))
    expect([...snap.rows.get('tags')!.keys()].sort()).toEqual(['tag000000001', 'tag000000002'])
    expect([...snap.rows.get('accounts')!.keys()]).toEqual(['acc000000001'])
    expect(snap.rows.get('transactions')!.size).toBe(0)
  })

  it('has no info and an empty base on a fresh database', async () => {
    const db = await open()
    expect(await readSyncBaseInfo(db)).toBeNull()
    expect((await readSyncBase(db)).size).toBe(0)
  })

  it('round-trips a written base and replaces it entirely on the next write', async () => {
    const db = await open()
    const first: Snapshot = {
      databaseHash: 'sha256:aa',
      rows: new Map([
        [
          'tags',
          new Map([
            ['t1', 'h1'],
            ['t2', 'h2'],
          ]),
        ],
        ['accounts', new Map([['a1', 'h3']])],
      ]),
    }
    await db.transaction((tx) => writeSyncBase(tx, first, { remoteId: 'r1', schemaVersion: 3 }))
    expect(await readSyncBase(db)).toEqual(first.rows)
    expect(await readSyncBaseInfo(db)).toEqual({
      remoteId: 'r1',
      schemaVersion: 3,
      databaseHash: 'sha256:aa',
    })

    const second: Snapshot = {
      databaseHash: 'sha256:bb',
      rows: new Map([['tags', new Map([['t1', 'h9']])]]),
    }
    await db.transaction((tx) => writeSyncBase(tx, second, { remoteId: 'r2', schemaVersion: 4 }))
    expect(await readSyncBase(db)).toEqual(second.rows)
    expect(await readSyncBaseInfo(db)).toEqual({
      remoteId: 'r2',
      schemaVersion: 4,
      databaseHash: 'sha256:bb',
    })
  })
})
