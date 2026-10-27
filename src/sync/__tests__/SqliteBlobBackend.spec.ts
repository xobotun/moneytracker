import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { SqliteBlobBackend } from '../SqliteBlobBackend'
import { FakeBlobTransport } from './fakes'
import { rowsEqual } from '../rows'
import { SYNC_TABLES } from '../syncTables'
import { newId } from '../../db/uuid'
import type { SyncMetadata } from '../types'

async function migratedDb(): Promise<Database> {
  const db = new Database()
  await db.init()
  await runMigrations(db, [settingsMigration, domainMigration])
  return db
}

const CUTOFF = '2026-05-01T00:00:00.000Z'
const META = (over: Partial<SyncMetadata> = {}): SyncMetadata => ({
  device: 'dev-A',
  uploadedAtUtc: '2026-05-28T10:00:00.000Z',
  hash: 'sha256:placeholder',
  migrationVersion: 2,
  ...over,
})

describe('SqliteBlobBackend', () => {
  let dbs: Database[] = []
  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
  })

  function setup() {
    const transport = new FakeBlobTransport()
    const backend = new SqliteBlobBackend(transport)
    return { transport, backend }
  }

  it('getMetadata returns null when sidecar is empty', async () => {
    const { backend } = setup()
    expect(await backend.getMetadata()).toBeNull()
  })

  it('first-sync upload succeeds with expected = null', async () => {
    const { backend } = setup()
    const local = await migratedDb()
    dbs.push(local)
    await local.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'Home', '[]', ?, ?, ?)`,
      [newId(), CUTOFF, CUTOFF, CUTOFF],
    )
    await backend.getMetadata()
    const ok = await backend.tryUpload(
      local,
      META({ hash: await backend.hashDatabase(local) }),
      null,
    )
    expect(ok).toBe(true)

    const m = await backend.getMetadata()
    expect(m).toMatchObject({ device: 'dev-A', migrationVersion: 2 })
  })

  it('downloadDatabase rebuilds the uploaded DB byte-for-byte', async () => {
    const { backend } = setup()
    const src = await migratedDb()
    dbs.push(src)
    const locId = newId()
    const accId = newId()
    await src.run(
      `INSERT INTO tags (id, kind, name, synonyms, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', 'Home', '[]', ?, ?, ?)`,
      [locId, CUTOFF, CUTOFF, CUTOFF],
    )
    await src.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, location_id,
                             colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, 'Checking', 'USD', 0, 2, ?, '#000000', 'wallet', ?, ?)`,
      [accId, locId, CUTOFF, CUTOFF],
    )
    await backend.getMetadata()
    await backend.tryUpload(src, META({ hash: await backend.hashDatabase(src) }), null)
    const downloaded = await backend.downloadDatabase()
    dbs.push(downloaded)
    for (const t of SYNC_TABLES) {
      const a = await src.exec<Record<string, unknown>>(`SELECT * FROM ${t.name} ORDER BY ${t.pk}`)
      const b = await downloaded.exec<Record<string, unknown>>(
        `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
      )
      expect(b.length).toBe(a.length)
      for (let i = 0; i < a.length; i++) {
        expect(rowsEqual(a[i]!, b[i]!), `${t.name}[${i}]`).toBe(true)
      }
    }
  })

  it('tryUpload returns false when sidecar etag drifts (CAS miss)', async () => {
    const { backend, transport } = setup()
    const local = await migratedDb()
    dbs.push(local)
    await backend.getMetadata()
    await backend.tryUpload(local, META({ hash: await backend.hashDatabase(local) }), null)

    const expected = await backend.getMetadata()
    // Foreign device updates the sidecar.
    transport.forceSidecar('{"foreign":"yes"}')
    const ok = await backend.tryUpload(
      local,
      META({ hash: await backend.hashDatabase(local) }),
      expected,
    )
    expect(ok).toBe(false)
  })

  it('tryUpload throws if called without prior getMetadata and expected is non-null', async () => {
    const { backend } = setup()
    const local = await migratedDb()
    dbs.push(local)
    const m = META({ hash: await backend.hashDatabase(local) })
    await expect(backend.tryUpload(local, m, m)).rejects.toThrow(/getMetadata/)
  })

  it('tryUpload throws if called without prior getMetadata even with expected === null', async () => {
    const { backend } = setup()
    const local = await migratedDb()
    dbs.push(local)
    const m = META({ hash: await backend.hashDatabase(local) })
    await expect(backend.tryUpload(local, m, null)).rejects.toThrow(/getMetadata/)
  })
})
