import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { hashDatabase } from '../hashDatabase'
import type { SyncBackend } from '../SyncBackend'
import { metadataEquals } from '../SyncBackend'
import type { SyncMetadata } from '../types'
import { SYNC_TABLES } from '../syncTables'
import { type GitHubFetch, GitHubTransport, type TreeEntry } from '../GitHubTransport'

/**
 * In-memory SyncBackend for unit tests. Holds an open Database directly as
 * the "remote state" — no codec round-trip needed, no transport simulated.
 * The tests that exercise the real CSV and blob codecs live in their own
 * spec files; this fake is exclusively for the orchestrator suite.
 */
export class FakeSyncBackend implements SyncBackend {
  private remoteDb: Database | null = null
  private remoteMeta: SyncMetadata | null = null
  /** Matches both real backends' field name for the "has getMetadata been
   *  called yet" guard on tryUpload. */
  private getMetadataCalled = false

  /** Test hook: simulate the remote being updated by some other writer. */
  async setRemote(db: Database, meta: SyncMetadata): Promise<void> {
    if (this.remoteDb) await this.remoteDb.close()
    this.remoteDb = db
    this.remoteMeta = meta
  }

  async getMetadata(): Promise<SyncMetadata | null> {
    this.getMetadataCalled = true
    return this.remoteMeta
  }

  async downloadDatabase(): Promise<Database> {
    if (!this.remoteDb) throw new Error('FakeSyncBackend: no remote database')
    // Return a *clone* so the orchestrator's mutations don't leak back into
    // the simulated remote. The cheapest correct clone is: export every row
    // into a fresh migrated DB.
    const clone = new Database()
    await clone.init()
    await runMigrations(clone, [settingsMigration, domainMigration])
    // Copy rows in FK order via the merge engine's helpers. For test
    // simplicity, just re-import via a direct SELECT/INSERT loop per table.
    for (const t of SYNC_TABLES) {
      const rows = await this.remoteDb.exec<Record<string, unknown>>(`SELECT * FROM ${t.name}`)
      for (const row of rows) {
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        await clone.run(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${placeholders})`,
          cols.map((c) => row[c]),
        )
      }
    }
    return clone
  }

  async hashDatabase(db: Database): Promise<string> {
    return hashDatabase(db)
  }

  async tryUpload(
    localDb: Database,
    metadata: SyncMetadata,
    expected: SyncMetadata | null,
  ): Promise<boolean> {
    if (!this.getMetadataCalled) {
      // The orchestrator must have called getMetadata() first — matches the
      // unconditional guard in both real backends.
      throw new Error('FakeSyncBackend.tryUpload called without prior getMetadata')
    }
    // CAS check: current remote must still equal what the caller saw.
    const currentEquals = metadataEquals(this.remoteMeta, expected)
    if (!currentEquals) return false

    // Accept the upload: clone localDb into the remote slot the same way
    // downloadDatabase does, so the next download returns a fresh clone too.
    const clone = new Database()
    await clone.init()
    await runMigrations(clone, [settingsMigration, domainMigration])
    for (const t of SYNC_TABLES) {
      const rows = await localDb.exec<Record<string, unknown>>(`SELECT * FROM ${t.name}`)
      for (const row of rows) {
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        await clone.run(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${placeholders})`,
          cols.map((c) => row[c]),
        )
      }
    }
    if (this.remoteDb) await this.remoteDb.close()
    this.remoteDb = clone
    this.remoteMeta = metadata
    return true
  }

  /** Test hook: introspect the simulated remote without going through download. */
  peekMeta(): SyncMetadata | null {
    return this.remoteMeta
  }

  async close(): Promise<void> {
    if (this.remoteDb) await this.remoteDb.close()
    this.remoteDb = null
    this.remoteMeta = null
  }
}

/**
 * In-memory simulation of the GitHub REST data API. Stores blobs (sha →
 * text), trees (sha → entries), commits, and the single branch HEAD.
 * Backs a real GitHubTransport via a custom fetch, so backend tests
 * exercise production transport code with no network. Enforces
 * fast-forward on updateRef (CAS via 422).
 */
export class FakeGitHubRemote {
  private blobs = new Map<string, string>()
  private trees = new Map<string, TreeEntry[]>()
  private commits = new Map<string, { tree: string; parents: string[]; atUtc: string }>()
  private branchHead: string | null = null
  private nextSha = 1

  fetch(): GitHubFetch {
    return async (url, init) => {
      const u = new URL(url)
      const method = init?.method ?? 'GET'
      const body = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : undefined

      if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) {
        return jsonRes(200, { name: 'mt' })
      }
      const contentsMatch = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/)
      if (method === 'GET' && contentsMatch) {
        const sha = this.pathSha(decodeURIComponent(contentsMatch[1]!))
        if (!sha) return jsonRes(404, { message: 'not found' })
        return jsonRes(200, {
          content: encodeBase64Utf8(this.blobs.get(sha)!),
          encoding: 'base64',
        })
      }
      if (method === 'GET' && /\/git\/refs\/heads\//.test(u.pathname)) {
        if (!this.branchHead) return jsonRes(404, { message: 'not found' })
        return jsonRes(200, { object: { sha: this.branchHead } })
      }
      const commitGet = u.pathname.match(/\/git\/commits\/([^/]+)$/)
      if (method === 'GET' && commitGet) {
        const c = this.commits.get(commitGet[1]!)
        if (!c) return jsonRes(404, { message: 'not found' })
        return jsonRes(200, { tree: { sha: c.tree } })
      }
      const treeGet = u.pathname.match(/\/git\/trees\/([^/]+)$/)
      if (method === 'GET' && treeGet && u.searchParams.get('recursive') === '1') {
        const entries = this.trees.get(treeGet[1]!)
        if (!entries) return jsonRes(404, { message: 'not found' })
        return jsonRes(200, {
          sha: treeGet[1],
          tree: entries.map((e) => ({ path: e.path, type: 'blob', sha: e.sha, mode: '100644' })),
          truncated: false,
        })
      }
      const blobGet = u.pathname.match(/\/git\/blobs\/([^/]+)$/)
      if (method === 'GET' && blobGet) {
        const text = this.blobs.get(blobGet[1]!)
        if (text === undefined) return jsonRes(404, { message: 'not found' })
        return jsonRes(200, { content: encodeBase64Utf8(text), encoding: 'base64' })
      }
      if (method === 'POST' && u.pathname.endsWith('/git/blobs')) {
        const sha = `b${this.nextSha++}`
        this.blobs.set(sha, decodeBase64Utf8((body as { content: string }).content))
        return jsonRes(201, { sha })
      }
      if (method === 'POST' && u.pathname.endsWith('/git/trees')) {
        const sha = `t${this.nextSha++}`
        const entries = (body!.tree as Array<{ path: string; sha: string }>).map((e) => ({
          path: e.path,
          sha: e.sha,
        }))
        if (body!.base_tree) {
          const base = this.trees.get(body!.base_tree as string) ?? []
          const replaced = new Set(entries.map((e) => e.path))
          for (const e of base) if (!replaced.has(e.path)) entries.push(e)
        }
        this.trees.set(sha, entries)
        return jsonRes(201, { sha })
      }
      if (method === 'POST' && u.pathname.endsWith('/git/commits')) {
        const sha = `c${this.nextSha++}`
        this.commits.set(sha, {
          tree: body!.tree as string,
          parents: body!.parents as string[],
          atUtc: (body!.committer as { date: string }).date,
        })
        return jsonRes(201, { sha })
      }
      if (method === 'PATCH' && /\/git\/refs\/heads\//.test(u.pathname)) {
        const target = body!.sha as string
        if (!this.isAncestor(this.branchHead, target)) {
          return jsonRes(422, { message: 'Update is not a fast forward' })
        }
        this.branchHead = target
        return jsonRes(200, {})
      }
      if (method === 'POST' && u.pathname.endsWith('/git/refs')) {
        if (this.branchHead) return jsonRes(422, { message: 'Reference already exists' })
        this.branchHead = body!.sha as string
        return jsonRes(201, {})
      }
      return jsonRes(404, { message: `unhandled ${method} ${u.pathname}` })
    }
  }

  transport(cfg: { repo: string; branch: string; token: string; path: string }): GitHubTransport {
    return new GitHubTransport(cfg, this.fetch())
  }

  /** Test introspection: the file content at this path in the current HEAD. */
  blobAt(path: string): string | null {
    const sha = this.pathSha(path)
    return sha ? (this.blobs.get(sha) ?? null) : null
  }

  headSha(): string | null {
    return this.branchHead
  }

  /** Test hook: simulate a foreign commit landing while the backend was
   *  doing other work. Used to test CAS-miss behaviour. */
  injectForeignCommit(treeEntries: Array<{ path: string; content: string }>): void {
    const treeEntriesWithSha = treeEntries.map((e) => {
      const sha = `b${this.nextSha++}`
      this.blobs.set(sha, e.content)
      return { path: e.path, sha }
    })
    const treeSha = `t${this.nextSha++}`
    // Merge with current head's tree to preserve untouched paths.
    let merged = treeEntriesWithSha
    if (this.branchHead) {
      const currentTreeSha = this.commits.get(this.branchHead)!.tree
      const base = this.trees.get(currentTreeSha) ?? []
      const replaced = new Set(treeEntriesWithSha.map((e) => e.path))
      merged = [...treeEntriesWithSha, ...base.filter((e) => !replaced.has(e.path))]
    }
    this.trees.set(treeSha, merged)
    const commitSha = `c${this.nextSha++}`
    this.commits.set(commitSha, {
      tree: treeSha,
      parents: this.branchHead ? [this.branchHead] : [],
      atUtc: '2026-05-28T00:00:00.000Z',
    })
    this.branchHead = commitSha
  }

  /** Test hook: commit on HEAD a tree without `path` (a file vanishing from the remote). */
  removePath(path: string): void {
    const currentTreeSha = this.commits.get(this.branchHead!)!.tree
    const treeSha = `t${this.nextSha++}`
    this.trees.set(
      treeSha,
      (this.trees.get(currentTreeSha) ?? []).filter((e) => e.path !== path),
    )
    const commitSha = `c${this.nextSha++}`
    this.commits.set(commitSha, {
      tree: treeSha,
      parents: [this.branchHead!],
      atUtc: '2026-05-28T00:00:00.000Z',
    })
    this.branchHead = commitSha
  }

  private pathSha(path: string): string | null {
    if (!this.branchHead) return null
    const commit = this.commits.get(this.branchHead)
    if (!commit) return null
    const tree = this.trees.get(commit.tree)
    return tree?.find((e) => e.path === path)?.sha ?? null
  }

  private isAncestor(ancestor: string | null, descendant: string): boolean {
    if (!ancestor) return true
    let cursor: string | undefined = descendant
    while (cursor) {
      if (cursor === ancestor) return true
      cursor = this.commits.get(cursor)?.parents[0]
    }
    return false
  }
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
// encodeBase64Utf8 and decodeBase64Utf8 are duplicated here to keep the
// fake self-contained — exporting them from the transport would be the
// only alternative, but they're an internal helper there.
function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

import type { BlobTransport } from '../BlobTransport'

/** In-memory BlobTransport. Tracks etags so conditional PUT works. */
export class FakeBlobTransport implements BlobTransport {
  private blob: Uint8Array | null = null
  private sidecar: { text: string; etag: string } | null = null
  private nextEtag = 1

  async validate(): Promise<void> {}

  async getSidecar(): Promise<{ text: string; etag: string } | null> {
    return this.sidecar ? { ...this.sidecar } : null
  }

  async putBlob(bytes: Uint8Array): Promise<void> {
    this.blob = new Uint8Array(bytes)
  }

  async putSidecar(text: string, expectedEtag: string | null): Promise<boolean> {
    if (expectedEtag === null) {
      if (this.sidecar !== null) return false // 412: was not absent
    } else {
      if (!this.sidecar || this.sidecar.etag !== expectedEtag) return false // 412
    }
    this.sidecar = { text, etag: `e${this.nextEtag++}` }
    return true
  }

  async getBlob(): Promise<Uint8Array> {
    if (!this.blob) throw new Error('FakeBlobTransport: no blob')
    return new Uint8Array(this.blob)
  }

  /** Test hook: simulate a foreign upload. */
  forceSidecar(text: string): void {
    this.sidecar = { text, etag: `e${this.nextEtag++}` }
  }
}
