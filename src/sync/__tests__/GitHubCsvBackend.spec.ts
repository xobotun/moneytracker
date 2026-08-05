import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { GitHubCsvBackend } from '../GitHubCsvBackend'
import { FakeGitHubRemote } from './fakes'
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

describe('GitHubCsvBackend', () => {
  let remotes: FakeGitHubRemote[] = []
  let dbs: Database[] = []
  afterEach(async () => {
    for (const db of dbs) await db.close()
    dbs = []
    remotes = []
  })

  function setup() {
    const remote = new FakeGitHubRemote()
    remotes.push(remote)
    const transport = remote.transport({ repo: 'me/mt', branch: 'main', token: 't', path: '' })
    const backend = new GitHubCsvBackend(transport)
    return { remote, backend }
  }

  it('getMetadata returns null on empty repo', async () => {
    const { backend } = setup()
    expect(await backend.getMetadata()).toBeNull()
  })

  it('first-sync upload bootstraps an empty repo', async () => {
    const { backend, remote } = setup()
    const local = await migratedDb()
    dbs.push(local)
    await local.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Home', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    const localHash = await backend.hashDatabase(local)

    await backend.getMetadata() // null
    const ok = await backend.tryUpload(local, META({ hash: localHash }), null)
    expect(ok).toBe(true)
    expect(remote.headSha()).not.toBeNull()
    expect(remote.blobAt('metadata.json')).toContain('"device":"dev-A"')
    expect(remote.blobAt('data/locations.csv')).toContain('Home')
    expect(remote.blobAt('README.md')).toMatch(/Moneytracker/)
    expect(remote.blobAt('.gitattributes')).toMatch(/\.csv text eol=lf/)
  })

  it('getMetadata after first sync returns the uploaded metadata', async () => {
    const { backend } = setup()
    const local = await migratedDb()
    dbs.push(local)
    const hash = await backend.hashDatabase(local)
    await backend.getMetadata()
    await backend.tryUpload(local, META({ hash }), null)

    const m = await backend.getMetadata()
    expect(m).toMatchObject({ device: 'dev-A', hash, migrationVersion: 2 })
  })

  it('downloadDatabase rebuilds a Database byte-identical to what was uploaded', async () => {
    const { backend } = setup()
    const src = await migratedDb()
    dbs.push(src)
    const locId = newId()
    const accId = newId()
    await src.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Home', '[]', ?, ?)`,
      [locId, CUTOFF, CUTOFF],
    )
    await src.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, location_id,
                             colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, 'Checking', 'USD', 0, 2, ?, '#000000', 'wallet', ?, ?)`,
      [accId, locId, CUTOFF, CUTOFF],
    )
    const hash = await backend.hashDatabase(src)
    await backend.getMetadata()
    await backend.tryUpload(src, META({ hash }), null)

    const downloaded = await backend.downloadDatabase()
    dbs.push(downloaded)
    for (const t of SYNC_TABLES) {
      const a = await src.exec<Record<string, unknown>>(
        `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
      )
      const b = await downloaded.exec<Record<string, unknown>>(
        `SELECT * FROM ${t.name} ORDER BY ${t.pk}`,
      )
      expect(b.length, t.name).toBe(a.length)
      for (let i = 0; i < a.length; i++) {
        expect(rowsEqual(a[i]!, b[i]!), `${t.name}[${i}]`).toBe(true)
      }
    }
  })

  it('hash in metadata.json matches hashDatabase(downloadedDb)', async () => {
    const { backend } = setup()
    const src = await migratedDb()
    dbs.push(src)
    await src.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'A', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    const srcHash = await backend.hashDatabase(src)
    await backend.getMetadata()
    await backend.tryUpload(src, META({ hash: srcHash }), null)

    const downloaded = await backend.downloadDatabase()
    dbs.push(downloaded)
    expect(await backend.hashDatabase(downloaded)).toBe(srcHash)
  })

  it('tryUpload returns false when a foreign commit lands between getMetadata and tryUpload', async () => {
    const { backend, remote } = setup()
    // Bootstrap.
    const a = await migratedDb()
    dbs.push(a)
    await backend.getMetadata()
    await backend.tryUpload(a, META({ hash: await backend.hashDatabase(a) }), null)

    // First call reads current state, caches HEAD SHA.
    const expectedMeta = await backend.getMetadata()

    // Foreign device pushes between now and our upload.
    remote.injectForeignCommit([
      { path: 'metadata.json', content: '{"device":"foreigner","uploadedAtUtc":"x","hash":"x","migrationVersion":2}' },
    ])

    const b = await migratedDb()
    dbs.push(b)
    await b.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'B', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    const ok = await backend.tryUpload(b, META({ hash: await backend.hashDatabase(b) }), expectedMeta)
    expect(ok).toBe(false)
  })

  it('tryUpload throws if called without a prior getMetadata (and remote exists)', async () => {
    const { backend } = setup()
    // Pre-seed the remote by doing a normal first upload.
    const a = await migratedDb()
    dbs.push(a)
    await backend.getMetadata()
    await backend.tryUpload(a, META({ hash: await backend.hashDatabase(a) }), null)

    // New backend instance, no prior getMetadata().
    const remote2 = remotes[0]!
    const fresh = new GitHubCsvBackend(
      remote2.transport({ repo: 'me/mt', branch: 'main', token: 't', path: '' }),
    )
    const meta = META({ hash: await fresh.hashDatabase(a) })
    await expect(fresh.tryUpload(a, meta, meta)).rejects.toThrow(/getMetadata/)
  })

  it('preserves an unrelated file (README.md) when committing a sync', async () => {
    const { backend, remote } = setup()
    // Bootstrap (creates README, metadata, .gitattributes, all six CSVs).
    const a = await migratedDb()
    dbs.push(a)
    await backend.getMetadata()
    await backend.tryUpload(a, META({ hash: await backend.hashDatabase(a) }), null)
    const readmeAfter1 = remote.blobAt('README.md')

    // Second sync — should keep README intact via base_tree.
    await backend.getMetadata()
    await backend.tryUpload(a, META({ hash: await backend.hashDatabase(a) }), await backend.getMetadata())
    expect(remote.blobAt('README.md')).toBe(readmeAfter1)
  })
})
