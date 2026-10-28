// Live test against a real GitHub repository — run with `npm run test:live`.
//
// Needs MT_GITHUB_TOKEN (fine-grained PAT, Contents: Read and write on the
// test repo only) and MT_GITHUB_REPO ("owner/name") in .env.test.local.
// Each run pushes to a fresh branch `unit-test-<16 hex chars>`, created
// by the backend's bootstrap path, so the repo's default branch is never
// touched. Branches left by runs older than a week are deleted first.
//
// The steps below share state and run in order: two simulated devices sync
// through the same branch, including a lost compare-and-swap race.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { primeIcon } from '@/icons/sets'
import type { Database } from '../../db/Database'
import { moneyAmount } from '../../db/MoneyAmount'
import { localMoment } from '../../db/LocalMoment'
import { AccountGroupingsRepository } from '../../db/repositories/AccountGroupingsRepository'
import { AccountsRepository } from '../../db/repositories/AccountsRepository'
import { AppliedRatesRepository } from '../../db/repositories/AppliedRatesRepository'
import { TagDetailsRepository } from '../../db/repositories/TagDetailsRepository'
import { TagsRepository } from '../../db/repositories/TagsRepository'
import { TransactionsRepository } from '../../db/repositories/TransactionsRepository'
import { newId } from '../../db/uuid'
import type { ShortId } from '../../db/shortId'
import { exportAllTables } from '../csvCodec'
import { GitHubCsvBackend } from '../GitHubCsvBackend'
import { gitBlobSha } from '../gitBlobSha'
import { GitHubTransport } from '../GitHubTransport'
import { hashDatabase } from '../hashDatabase'
import type { GitHubConfig } from '../localState/providerConfig'
import { runSync, type SyncDeps } from '../syncOrchestrator'
import { SYNC_TABLES } from '../syncTables'
import type { RemoteState, SyncMetadata } from '../types'
import { newMigratedDb } from './helpers'

const token = process.env.MT_GITHUB_TOKEN ?? ''
const repo = process.env.MT_GITHUB_REPO ?? ''

const BRANCH_PREFIX = 'unit-test-'
const STALE_BRANCH_AGE_MS = 7 * 24 * 60 * 60 * 1000

function randomBranchName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return BRANCH_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function githubApi(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
}

/** Deletes `unit-test-*` branches whose head commit is older than a week. */
async function deleteStaleTestBranches(): Promise<void> {
  const res = await githubApi(`/git/matching-refs/heads/${BRANCH_PREFIX}`)
  if (!res.ok) throw new Error(`listing test branches: ${res.status} ${await res.text()}`)
  const refs = (await res.json()) as { ref: string; object: { sha: string } }[]
  for (const { ref, object } of refs) {
    const commitRes = await githubApi(`/git/commits/${object.sha}`)
    if (!commitRes.ok) throw new Error(`reading ${ref}: ${commitRes.status}`)
    const commit = (await commitRes.json()) as { committer: { date: string } }
    if (Date.now() - Date.parse(commit.committer.date) < STALE_BRANCH_AGE_MS) continue
    const del = await githubApi(`/git/${ref}`, { method: 'DELETE' })
    if (!del.ok) throw new Error(`deleting ${ref}: ${del.status} ${await del.text()}`)
    console.log(`deleted stale test branch ${ref}`)
  }
}

/** A simulated device: its own database, backend instance and last-known remote state. */
interface Device {
  db: Database
  backend: GitHubCsvBackend
  deps: SyncDeps
  lastKnown: RemoteState | null
}

function newDevice(db: Database, cfg: GitHubConfig, deviceName: string): Device {
  const backend = new GitHubCsvBackend(new GitHubTransport(cfg))
  const device: Device = {
    db,
    backend,
    lastKnown: null,
    deps: {
      backend,
      deviceName,
      now: () => new Date(),
      migrate: async () => {
        throw new Error('both devices run the same schema; no migration expected')
      },
      loadLastKnown: () => device.lastKnown,
      saveLastKnown: (s) => {
        device.lastKnown = s
      },
    },
  }
  return device
}

/** All files on a branch: path → git blob id. */
async function remoteFiles(branch: string): Promise<Map<string, string>> {
  const res = await githubApi(`/git/trees/${branch}?recursive=1`)
  if (!res.ok) throw new Error(`listing the branch tree: ${res.status} ${await res.text()}`)
  const tree = (await res.json()) as { tree: { path: string; type: string; sha: string }[] }
  return new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]))
}

async function rowCounts(db: Database): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of SYNC_TABLES) {
    const [row] = await db.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.name}`)
    out[t.name] = row!.n
  }
  return out
}

/**
 * Data chosen to stress the CSV round trip: Unicode, characters CSV must
 * escape (quotes, commas, newlines), NULLs and empty strings, negative and large amounts,
 * fractional coordinates, JSON columns, a non-Berlin zone and soft deletes.
 */
async function populate(db: Database): Promise<{ eurAccount: ShortId; rubAccount: ShortId }> {
  const tags = new TagsRepository(db)
  const tagDetails = new TagDetailsRepository(db)
  const rates = new AppliedRatesRepository(db)
  const accounts = new AccountsRepository(db)
  const groupings = new AccountGroupingsRepository(db)
  const transactions = new TransactionsRepository(db)

  const cafe = await tags.create({
    kind: 'location',
    name: 'Café "Zum Löwen", Kreuzberg',
    description: 'First line\nsecond line, with "quotes"',
    synonyms: ['coffee', 'кофе'],
  })
  await tagDetails.setLocation(cafe.id, {
    address: 'Oranienstraße 1',
    latitude: 52.499_123_456,
    longitude: 13.418_9,
    merchant_id: null,
  })
  const nowhere = await tags.create({ kind: 'location', name: 'Nowhere', description: null })
  await tagDetails.setLocation(nowhere.id, {
    address: '', // stored as NULL — '' cannot survive a CSV cell
    latitude: 0,
    longitude: -0.5,
    merchant_id: null,
  })
  await tags.softDelete(nowhere.id)

  const food = await tags.create({
    kind: 'tag',
    name: 'food',
    colour: '#ff8800',
    icon: primeIcon('shopping-cart'),
    synonyms: ['еда', 'Essen'],
    description: '',
  })
  const travel = await tags.create({
    kind: 'tag',
    name: 'travel ✈️',
    colour: '#0088ff',
    icon: primeIcon('globe'),
    synonyms: [],
    description: 'Trips, "holidays", etc.',
  })
  const obsolete = await tags.create({
    kind: 'tag',
    name: 'obsolete',
    colour: '#000000',
    icon: primeIcon('times'),
  })
  await tags.softDelete(obsolete.id)
  const eating = await tags.create({ kind: 'category', name: 'Food' })
  const savings = await tags.create({ kind: 'category', name: 'Savings, "rainy day"' })
  const kiez = await tags.create({ kind: 'merchant', name: 'Kiezkaffee' })
  const moscow = await tags.create({ kind: 'journey', name: 'Москва 2026' })

  await rates.saveAuto({
    date: '2026-10-17',
    x: 'EUR',
    y: 'USD',
    resolution: { rate: 1.0842, provider: 'ecb', via: null, referenceDate: '2026-10-16' },
  })
  await rates.saveAuto({ date: '2026-10-17', x: 'MILES', y: 'EUR', resolution: null })
  await rates.setManual('2026-10-17', 'EUR', 'RUB', 98.512_3)

  const allMoney = await groupings.create({
    name: 'All "money"',
    colour: '#778899',
    icon: primeIcon('th-large'),
  })

  const eur = await accounts.create({
    name: 'Girokonto',
    balance: moneyAmount(-12_345, 2, 'EUR'),
    tags: [food.id],
    location_id: cafe.id,
    colour: '#112233',
    icon: primeIcon('wallet'),
    grouping_id: allMoney.id,
  })
  const rub = await accounts.create({
    name: 'Наличные, рубли',
    balance: moneyAmount(9_007_199_254_740_991, 2, 'RUB'),
    tags: [],
    location_id: null,
    colour: '#445566',
    icon: primeIcon('money-bill'),
    grouping_id: null,
  })

  // Expense.
  await transactions.create({
    account_id__from: eur.id,
    account_id__to: null,
    amount__from: moneyAmount(450, 2, 'EUR'),
    amount__to: moneyAmount(450, 2, 'EUR'),
    transaction_at: localMoment('2026-10-17T08:15:00.000+02:00', 'Europe/Berlin'),
    date_override: null,
    tags: [food.id, travel.id],
    categories: [
      {
        category_id: eating.id,
        amount__from: moneyAmount(450, 2, 'EUR'),
        amount__to: moneyAmount(450, 2, 'EUR'),
      },
    ],
    merchant_id: kiez.id,
    location_lat: 52.499_1,
    location_lon: 13.418_9,
    location_id: cafe.id,
  })
  // Income.
  await transactions.create({
    account_id__from: null,
    account_id__to: rub.id,
    amount__from: moneyAmount(1_000_000, 2, 'RUB'),
    amount__to: moneyAmount(1_000_000, 2, 'RUB'),
    transaction_at: localMoment('2026-10-16T23:59:59.999+03:00', 'Europe/Moscow'),
    date_override: null,
    tags: [],
    categories: [
      {
        category_id: savings.id,
        amount__from: moneyAmount(1_000_000, 2, 'RUB'),
        amount__to: moneyAmount(1_000_000, 2, 'RUB'),
      },
    ],
    location_lat: null,
    location_lon: null,
    location_id: null,
    journey_id: moscow.id,
  })
  // Cross-currency transfer with a date override in another zone.
  await transactions.create({
    account_id__from: eur.id,
    account_id__to: rub.id,
    amount__from: moneyAmount(10_000, 2, 'EUR'),
    amount__to: moneyAmount(985_123, 2, 'RUB'),
    transaction_at: localMoment('2026-10-15T12:00:00.000+02:00', 'Europe/Berlin'),
    date_override: localMoment('2026-10-14T18:30:00.000-04:00', 'America/New_York'),
    tags: [travel.id],
    // Split at extra precision: 66.6667 € + 33.3333 € and 6,567.4867 + 3,283.7433 RUB.
    categories: [
      {
        category_id: savings.id,
        amount__from: moneyAmount(666_667, 4, 'EUR'),
        amount__to: moneyAmount(65_674_867, 4, 'RUB'),
      },
      {
        category_id: eating.id,
        amount__from: moneyAmount(333_333, 4, 'EUR'),
        amount__to: moneyAmount(32_837_433, 4, 'RUB'),
      },
    ],
    location_lat: null,
    location_lon: null,
    location_id: null,
  })
  // Soft-deleted expense.
  const mistake = await transactions.create({
    account_id__from: eur.id,
    account_id__to: null,
    amount__from: moneyAmount(1, 0, 'EUR'),
    amount__to: moneyAmount(1, 0, 'EUR'),
    transaction_at: localMoment('2026-10-17T09:00:00.000+02:00', 'Europe/Berlin'),
    date_override: null,
    tags: [],
    categories: [
      {
        category_id: eating.id,
        amount__from: moneyAmount(1, 0, 'EUR'),
        amount__to: moneyAmount(1, 0, 'EUR'),
      },
    ],
    location_lat: null,
    location_lon: null,
    location_id: null,
  })
  await transactions.softDelete(mistake.id)

  // Enough more expenses to need three numbered transaction files (2,345 rows).
  const bulk = Array.from({ length: 2_341 }, (_, i) => ({
    id: newId(),
    cents: 100 + i,
    day: String(1 + (i % 28)).padStart(2, '0'),
  }))
  await db.run(
    `INSERT INTO transactions (
       id, account_id__from, account_id__to,
       amount_value__from, amount_scale__from, amount_currency__from,
       amount_value__to, amount_scale__to, amount_currency__to,
       transaction_at_local, transaction_at_zone, tags, created_at_utc, updated_at_utc)
     SELECT json_extract(value, '$.id'), ?, NULL,
            json_extract(value, '$.cents'), 2, 'EUR',
            json_extract(value, '$.cents'), 2, 'EUR',
            '2026-09-' || json_extract(value, '$.day') || 'T12:00:00.000+02:00', 'Europe/Berlin',
            '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
     FROM json_each(?)`,
    [eur.id, JSON.stringify(bulk)],
  )

  return { eurAccount: eur.id, rubAccount: rub.id }
}

describe.sequential('GitHubCsvBackend against real GitHub', () => {
  const cfg: GitHubConfig = { repo, branch: randomBranchName(), token }
  const opened: Database[] = []
  let a: Device
  let b: Device
  /** A device that checked the empty branch together with A, but uploads after A. */
  let late: Device
  let accountsOfA: { eurAccount: ShortId; rubAccount: ShortId }

  /** A device that has never synced: its own backend, no cached HEAD. */
  async function downloadFresh(): Promise<{ meta: SyncMetadata | null; db: Database }> {
    const backend = new GitHubCsvBackend(new GitHubTransport(cfg))
    const meta = await backend.getMetadata()
    const db = await backend.downloadDatabase()
    opened.push(db)
    return { meta, db }
  }

  beforeAll(async () => {
    if (!token || !repo) {
      throw new Error('Set MT_GITHUB_TOKEN and MT_GITHUB_REPO in .env.test.local')
    }
    console.log(`live sync test: https://github.com/${repo}/tree/${cfg.branch}`)
    await deleteStaleTestBranches()

    const dbA = await newMigratedDb()
    opened.push(dbA)
    accountsOfA = await populate(dbA)
    a = newDevice(dbA, cfg, 'live-test-device-A')

    const dbLate = await newMigratedDb()
    opened.push(dbLate)
    await new TagsRepository(dbLate).create({
      kind: 'tag',
      name: 'late',
      colour: '#000000',
      icon: primeIcon('clock'),
      synonyms: [],
    })
    late = newDevice(dbLate, cfg, 'live-test-device-late')
  })

  afterAll(async () => {
    for (const db of opened) await db.close()
  })

  it('starts from a branch that does not exist yet', async () => {
    expect(await a.backend.getMetadata()).toBeNull()
    expect(await late.backend.getMetadata()).toBeNull()
  })

  it('device A bootstraps the branch with its database', async () => {
    const outcome = await runSync(a.db, a.deps)
    expect(outcome.decision).toBe('first-sync-upload')
    expect(a.lastKnown?.hash).toBe(await hashDatabase(a.db))
  })

  it('stores every table as numbered files of at most 1000 rows', async () => {
    const paths = [...(await remoteFiles(cfg.branch)).keys()]
    for (const n of ['0001', '0002', '0003']) {
      expect(paths).toContain(`data/transactions-${n}.csv`)
    }
    expect(paths).not.toContain('data/transactions-0004.csv')
    for (const t of SYNC_TABLES) {
      expect(paths).toContain(`data/${t.name}-0001.csv`)
      expect(paths).not.toContain(`data/${t.name}.csv`)
    }
  })

  it('computes the same git blob ids as GitHub, so unchanged files are not re-sent', async () => {
    // tryUpload skips a file when its locally computed id equals the remote's;
    // if the two ever disagreed, every file would silently be re-uploaded.
    const remote = await remoteFiles(cfg.branch)
    for (const [table, files] of await exportAllTables(a.db)) {
      for (let i = 0; i < files.length; i++) {
        const path = `data/${table}-${String(i + 1).padStart(4, '0')}.csv`
        expect(await gitBlobSha(files[i]!), path).toBe(remote.get(path))
      }
    }
  })

  it('a second device bootstrapping the same branch loses the race cleanly', async () => {
    const meta: SyncMetadata = {
      device: 'live-test-device-late',
      uploadedAtUtc: new Date().toISOString(),
      hash: await hashDatabase(late.db),
      migrationVersion: 2,
    }
    // It saw no branch, so it tries to create one — but A already has.
    expect(await late.backend.tryUpload(late.db, meta, null)).toBe(false)
    expect((await downloadFresh()).meta?.device).toBe('live-test-device-A')
  })

  it('a fresh download reproduces device A exactly', async () => {
    const { meta, db } = await downloadFresh()
    expect(meta?.device).toBe('live-test-device-A')
    expect(await rowCounts(db)).toEqual(await rowCounts(a.db))
    expect(await hashDatabase(db)).toBe(await hashDatabase(a.db))
  })

  it('device B merges its edit on top of a normal (non-bootstrap) commit', async () => {
    const { meta, db } = await downloadFresh()
    b = newDevice(db, cfg, 'live-test-device-B')
    b.lastKnown = { device: meta!.device, uploadedAtUtc: meta!.uploadedAtUtc, hash: meta!.hash }

    // B uses the tags it downloaded from A.
    const tagsOfB = new TagsRepository(b.db)
    const food = (await tagsOfB.findByName('tag', 'food'))!
    const eating = (await tagsOfB.findByName('category', 'Food'))!
    const amount = moneyAmount(25_000, 2, 'RUB')
    await new TransactionsRepository(b.db).create({
      account_id__from: accountsOfA.rubAccount,
      account_id__to: null,
      amount__from: amount,
      amount__to: amount,
      transaction_at: localMoment('2026-10-18T10:00:00.000+03:00', 'Europe/Moscow'),
      date_override: null,
      tags: [food.id],
      categories: [{ category_id: eating.id, amount__from: amount, amount__to: amount }],
      location_lat: null,
      location_lon: null,
      location_id: null,
    })

    const outcome = await runSync(b.db, b.deps)
    expect(outcome.decision).toBe('merge')
    expect(outcome.uploaded).toBe(true)
    expect((await downloadFresh()).meta?.device).toBe('live-test-device-B')
  })

  it("device A's stale compare-and-swap is rejected", async () => {
    // A's backend still holds the HEAD it saw before B's commit.
    await new TagsRepository(a.db).create({
      kind: 'tag',
      name: 'added-on-A',
      colour: '#abcdef',
      icon: primeIcon('star'),
      synonyms: [],
    })
    const meta: SyncMetadata = {
      device: 'live-test-device-A',
      uploadedAtUtc: new Date().toISOString(),
      hash: await hashDatabase(a.db),
      migrationVersion: 2,
    }
    const ok = await a.backend.tryUpload(a.db, meta, {
      ...meta,
      hash: a.lastKnown!.hash,
      uploadedAtUtc: a.lastKnown!.uploadedAtUtc,
    })
    expect(ok).toBe(false)
  })

  it('device A then syncs by merging B, and both edits survive', async () => {
    const outcome = await runSync(a.db, a.deps)
    expect(outcome.decision).toBe('merge')
    expect(outcome.uploaded).toBe(true)

    const { db } = await downloadFresh()
    expect(await hashDatabase(db)).toBe(await hashDatabase(a.db))
    const counts = await rowCounts(db)
    expect(counts.transactions).toBe(2346) // 2,345 from A (one soft-deleted) + 1 from B
    expect(counts.tags).toBe(10) // 9 from A (incl. the two soft-deleted) + added-on-A
  })

  it('a second sync with nothing new is a no-op', async () => {
    const outcome = await runSync(a.db, a.deps)
    expect(outcome.decision).toBe('none')
    expect(outcome.uploaded).toBe(false)
  })
})
