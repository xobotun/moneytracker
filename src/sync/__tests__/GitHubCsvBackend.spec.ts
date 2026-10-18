import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { GitHubCsvBackend } from '../GitHubCsvBackend'
import { exportTableToCsvFiles } from '../csvCodec'
import { seedLocations } from './helpers'
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

  function setup(options: { rowsPerFileForTest?: number } = {}) {
    const remote = new FakeGitHubRemote()
    remotes.push(remote)
    const transport = remote.transport({ repo: 'me/mt', branch: 'main', token: 't', path: '' })
    const backend = new GitHubCsvBackend(transport, options)
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
    expect(remote.blobAt('data/locations-0001.csv')).toContain('Home')
    expect(remote.blobAt('README.md')).toMatch(/Moneytracker/)
    expect(remote.blobAt('.gitattributes')).toMatch(/\.csv text eol=lf/)
  })

  it('a second first-sync upload to the same empty repo loses the race (returns false)', async () => {
    const { backend: first, remote } = setup()
    const second = new GitHubCsvBackend(
      remote.transport({ repo: 'me/mt', branch: 'main', token: 't', path: '' }),
    )
    const local = await migratedDb()
    dbs.push(local)
    // Both devices see the empty repo before either uploads.
    expect(await first.getMetadata()).toBeNull()
    expect(await second.getMetadata()).toBeNull()

    expect(await first.tryUpload(local, META({ device: 'dev-A' }), null)).toBe(true)
    const headAfterFirst = remote.headSha()
    expect(await second.tryUpload(local, META({ device: 'dev-B' }), null)).toBe(false)
    expect(remote.headSha()).toBe(headAfterFirst)
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
      const a = await src.exec<Record<string, unknown>>(`SELECT * FROM ${t.name} ORDER BY ${t.pk}`)
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
      {
        path: 'metadata.json',
        content: '{"device":"foreigner","uploadedAtUtc":"x","hash":"x","migrationVersion":2}',
      },
      { path: 'foreign-only.txt', content: 'kept' },
    ])

    const b = await migratedDb()
    dbs.push(b)
    await b.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'B', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    const ok = await backend.tryUpload(
      b,
      META({ hash: await backend.hashDatabase(b) }),
      expectedMeta,
    )
    expect(ok).toBe(false)

    // Retry path: re-read the remote, then the same upload succeeds on top of the foreign commit.
    const refreshed = await backend.getMetadata()
    expect(refreshed?.device).toBe('foreigner')
    const retried = await backend.tryUpload(
      b,
      META({ device: 'dev-B', hash: await backend.hashDatabase(b) }),
      refreshed,
    )
    expect(retried).toBe(true)
    expect(remote.blobAt('metadata.json')).toContain('"device":"dev-B"')
    // A file only the foreign commit wrote survives (built on its tree via base_tree).
    expect(remote.blobAt('foreign-only.txt')).toBe('kept')
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

  it('downloadDatabase reads the commit getMetadata saw, even after the branch moved', async () => {
    const { backend, remote } = setup()
    const src = await migratedDb()
    dbs.push(src)
    await src.run(
      `INSERT INTO locations (id, name, tags, created_at_utc, updated_at_utc)
       VALUES (?, 'Home', '[]', ?, ?)`,
      [newId(), CUTOFF, CUTOFF],
    )
    await backend.getMetadata()
    await backend.tryUpload(src, META({ hash: await backend.hashDatabase(src) }), null)
    await backend.getMetadata()

    // A foreign commit empties locations and rewrites metadata after our getMetadata().
    const empty = await migratedDb()
    dbs.push(empty)
    const locations = SYNC_TABLES.find((t) => t.name === 'locations')!
    remote.injectForeignCommit([
      {
        path: 'data/locations-0001.csv',
        content: (await exportTableToCsvFiles(empty, locations))[0]!,
      },
      { path: 'metadata.json', content: JSON.stringify(META({ device: 'dev-X' })) },
    ])

    const downloaded = await backend.downloadDatabase()
    dbs.push(downloaded)
    const rows = await downloaded.exec<{ name: string }>('SELECT name FROM locations')
    expect(rows.map((r) => r.name)).toEqual(['Home'])
  })

  it('downloadDatabase throws without a prior getMetadata', async () => {
    const { backend, remote } = setup()
    const a = await migratedDb()
    dbs.push(a)
    await backend.getMetadata()
    await backend.tryUpload(a, META({ hash: await backend.hashDatabase(a) }), null)

    const fresh = new GitHubCsvBackend(
      remote.transport({ repo: 'me/mt', branch: 'main', token: 't', path: '' }),
    )
    await expect(fresh.downloadDatabase()).rejects.toThrow(/without prior getMetadata/)
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
    await backend.tryUpload(
      a,
      META({ hash: await backend.hashDatabase(a) }),
      await backend.getMetadata(),
    )
    expect(remote.blobAt('README.md')).toBe(readmeAfter1)
  })

  describe('chunked layout', () => {
    async function uploadFrom(backend: GitHubCsvBackend, db: Database) {
      await backend.getMetadata()
      await backend.tryUpload(db, META({ hash: await backend.hashDatabase(db) }), null)
      await backend.getMetadata()
    }

    it('writes data/<table>-0001.csv for every table, header-only when empty', async () => {
      const { backend, remote } = setup()
      const a = await migratedDb()
      dbs.push(a)
      await uploadFrom(backend, a)
      for (const t of SYNC_TABLES) {
        expect(remote.blobAt(`data/${t.name}-0001.csv`), t.name).toMatch(/\n$/)
        expect(remote.blobAt(`data/${t.name}.csv`), t.name).toBeNull()
      }
      expect(remote.blobAt('data/tags-0001.csv')!.trim().split('\n')).toHaveLength(1)
    })

    it('numbers files past -0003: four rows at one row per file give -0001..-0004', async () => {
      const { backend, remote } = setup({ rowsPerFileForTest: 1 })
      const a = await migratedDb()
      dbs.push(a)
      await seedLocations(a, 4)
      await uploadFrom(backend, a)
      for (const n of ['0001', '0002', '0003', '0004']) {
        expect(remote.blobAt(`data/locations-${n}.csv`), n).not.toBeNull()
      }
      expect(remote.blobAt('data/locations-0005.csv')).toBeNull()
      const downloaded = await backend.downloadDatabase()
      dbs.push(downloaded)
      expect(await backend.hashDatabase(downloaded)).toBe(await backend.hashDatabase(a))
    })

    it('a 2001-row table uploads as three files and downloads identically', async () => {
      const { backend, remote } = setup()
      const a = await migratedDb()
      dbs.push(a)
      await seedLocations(a, 2001)
      await uploadFrom(backend, a)
      for (const n of ['0001', '0002', '0003']) {
        expect(remote.blobAt(`data/locations-${n}.csv`), n).not.toBeNull()
      }
      expect(remote.blobAt('data/locations-0004.csv')).toBeNull()
      const downloaded = await backend.downloadDatabase()
      dbs.push(downloaded)
      expect(await backend.hashDatabase(downloaded)).toBe(await backend.hashDatabase(a))
    })

    it('download throws naming the missing file when numbering has a gap', async () => {
      const { backend, remote } = setup()
      const a = await migratedDb()
      dbs.push(a)
      await seedLocations(a, 2001)
      await uploadFrom(backend, a)
      remote.removePath('data/locations-0002.csv')
      await backend.getMetadata()
      await expect(backend.downloadDatabase()).rejects.toThrow(/missing data\/locations-0002\.csv/)
    })

    it('download ignores an old-layout data/<table>.csv', async () => {
      const { backend, remote } = setup()
      const a = await migratedDb()
      dbs.push(a)
      await uploadFrom(backend, a)
      const tags = SYNC_TABLES.find((t) => t.name === 'tags')!
      const withTag = await migratedDb()
      dbs.push(withTag)
      await withTag.run(
        `INSERT INTO tags (tag, description, synonyms, colour, icon, created_at_utc, updated_at_utc)
         VALUES ('old', NULL, '[]', '#00ff00', 'tag', ?, ?)`,
        [CUTOFF, CUTOFF],
      )
      remote.injectForeignCommit([
        { path: 'data/tags.csv', content: (await exportTableToCsvFiles(withTag, tags))[0]! },
      ])
      await backend.getMetadata()
      const downloaded = await backend.downloadDatabase()
      dbs.push(downloaded)
      expect(await downloaded.exec('SELECT tag FROM tags')).toEqual([])
    })
  })
})
