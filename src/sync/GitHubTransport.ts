import type { GitHubConfig } from './localState/providerConfig'

/** Injectable fetch — defaults to global fetch, overrideable for tests. */
export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface TreeEntry {
  path: string
  sha: string
}

export interface CommitParams {
  message: string
  tree: string
  parents: string[]
  authorName: string
  authorEmail: string
  /** ISO 8601 UTC, also used as committer.date. */
  atUtc: string
}

/**
 * Typed wrapper over the GitHub REST data API. Knows about authentication
 * and JSON encoding; knows nothing about CAS strategy — composing the
 * blob → tree → commit → ref-update sequence is the backend's job.
 *
 * 404 (not found) and 422 (non-fast-forward) are translated to null /
 * false so the backend can branch on them. Other non-2xx statuses throw
 * with the response body for diagnostics.
 */
export class GitHubTransport {
  constructor(
    private readonly cfg: GitHubConfig,
    private readonly fetch: GitHubFetch = globalThis.fetch.bind(globalThis),
  ) {}

  async validate(): Promise<void> {
    const res = await this.req(`/repos/${this.cfg.repo}`, { method: 'GET' })
    if (!res.ok) throw await asError(res, 'validate')
  }

  async getContent(path: string): Promise<string | null> {
    const res = await this.req(
      `/repos/${this.cfg.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(this.cfg.branch)}`,
      { method: 'GET' },
    )
    if (res.status === 404) return null
    if (!res.ok) throw await asError(res, 'getContent')
    const json = (await res.json()) as { content: string; encoding: string }
    if (json.encoding !== 'base64') {
      throw new Error(`GitHubTransport.getContent: unexpected encoding "${json.encoding}"`)
    }
    return decodeBase64Utf8(json.content)
  }

  async getRef(): Promise<string | null> {
    const res = await this.req(
      `/repos/${this.cfg.repo}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`,
      { method: 'GET' },
    )
    if (res.status === 404) return null
    if (!res.ok) throw await asError(res, 'getRef')
    const json = (await res.json()) as { object: { sha: string } }
    return json.object.sha
  }

  async getCommitTreeSha(commitSha: string): Promise<string> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/commits/${commitSha}`, {
      method: 'GET',
    })
    if (!res.ok) throw await asError(res, 'getCommitTreeSha')
    const json = (await res.json()) as { tree: { sha: string } }
    return json.tree.sha
  }

  async createBlob(content: string): Promise<string> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: encodeBase64Utf8(content), encoding: 'base64' }),
    })
    if (!res.ok) throw await asError(res, 'createBlob')
    return ((await res.json()) as { sha: string }).sha
  }

  async createTree(entries: TreeEntry[], baseTree: string | undefined): Promise<string> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: entries.map((e) => ({
          path: e.path,
          mode: '100644',
          type: 'blob',
          sha: e.sha,
        })),
      }),
    })
    if (!res.ok) throw await asError(res, 'createTree')
    return ((await res.json()) as { sha: string }).sha
  }

  async createCommit(p: CommitParams): Promise<string> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: p.message,
        tree: p.tree,
        parents: p.parents,
        author: { name: p.authorName, email: p.authorEmail, date: p.atUtc },
        committer: { name: p.authorName, email: p.authorEmail, date: p.atUtc },
      }),
    })
    if (!res.ok) throw await asError(res, 'createCommit')
    return ((await res.json()) as { sha: string }).sha
  }

  async updateRef(newSha: string): Promise<boolean> {
    const res = await this.req(
      `/repos/${this.cfg.repo}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`,
      { method: 'PATCH', body: JSON.stringify({ sha: newSha, force: false }) },
    )
    if (res.ok) return true
    if (res.status === 422) return false
    throw await asError(res, 'updateRef')
  }

  async createRef(newSha: string): Promise<void> {
    const res = await this.req(`/repos/${this.cfg.repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${this.cfg.branch}`, sha: newSha }),
    })
    if (!res.ok) throw await asError(res, 'createRef')
  }

  private req(path: string, init: RequestInit): Promise<Response> {
    return this.fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  }
}

async function asError(res: Response, op: string): Promise<Error> {
  const body = await res.text().catch(() => '')
  return new Error(`GitHubTransport.${op}: ${res.status} ${res.statusText} — ${body}`)
}

function encodeBase64Utf8(text: string): string {
  // btoa alone throws on non-Latin-1 — go through UTF-8 bytes first.
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function decodeBase64Utf8(b64: string): string {
  // GitHub's contents API base64 can contain newlines; strip them.
  const binary = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
