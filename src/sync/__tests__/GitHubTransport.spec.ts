import { describe, it, expect } from 'vitest'
import { GitHubTransport, type GitHubFetch } from '../GitHubTransport'

function makeFakeFetch(
  routes: Array<{ url: RegExp; method: string; status: number; body: unknown }>,
) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  const f: GitHubFetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url: url.toString(), method, body })
    for (const r of routes) {
      if (r.url.test(url.toString()) && r.method === method) {
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
  }
  return Object.assign(f, { calls })
}

const cfg = { repo: 'me/mt', branch: 'main', token: 'ghp_test', path: '' }

describe('GitHubTransport', () => {
  it('getContent returns null on 404', async () => {
    expect(await new GitHubTransport(cfg, makeFakeFetch([])).getContent('metadata.json')).toBeNull()
  })

  it('getContent decodes base64 to text on 200', async () => {
    const text = '{"device":"x"}'
    const fetchFn = makeFakeFetch([
      {
        url: /contents\/metadata\.json/,
        method: 'GET',
        status: 200,
        body: { content: btoa(text), encoding: 'base64' },
      },
    ])
    expect(await new GitHubTransport(cfg, fetchFn).getContent('metadata.json')).toBe(text)
  })

  it('getRef returns null on 404 and SHA on 200', async () => {
    expect(await new GitHubTransport(cfg, makeFakeFetch([])).getRef()).toBeNull()
    const ok = makeFakeFetch([
      {
        url: /git\/refs\/heads\/main/,
        method: 'GET',
        status: 200,
        body: { object: { sha: 'abc' } },
      },
    ])
    expect(await new GitHubTransport(cfg, ok).getRef()).toBe('abc')
  })

  it('createBlob POSTs base64-encoded content and returns the SHA', async () => {
    const fetchFn = makeFakeFetch([
      { url: /git\/blobs/, method: 'POST', status: 201, body: { sha: 'b1' } },
    ])
    expect(await new GitHubTransport(cfg, fetchFn).createBlob('hello\n')).toBe('b1')
    expect(fetchFn.calls.find((c) => c.method === 'POST')!.body).toEqual({
      content: btoa('hello\n'),
      encoding: 'base64',
    })
  })

  it('createTree POSTs entries + optional base_tree', async () => {
    const fetchFn = makeFakeFetch([
      { url: /git\/trees/, method: 'POST', status: 201, body: { sha: 't1' } },
    ])
    await new GitHubTransport(cfg, fetchFn).createTree(
      [
        { path: 'metadata.json', sha: 'b1' },
        { path: 'data/locations.csv', sha: 'b2' },
      ],
      'base-tree',
    )
    expect(fetchFn.calls.find((c) => c.method === 'POST')!.body).toEqual({
      base_tree: 'base-tree',
      tree: [
        { path: 'metadata.json', mode: '100644', type: 'blob', sha: 'b1' },
        { path: 'data/locations.csv', mode: '100644', type: 'blob', sha: 'b2' },
      ],
    })
  })

  it('updateRef returns true on 200 and false on 422', async () => {
    const ok = makeFakeFetch([
      { url: /git\/refs\/heads\/main/, method: 'PATCH', status: 200, body: {} },
    ])
    expect(await new GitHubTransport(cfg, ok).updateRef('new')).toBe(true)
    const miss = makeFakeFetch([
      { url: /git\/refs\/heads\/main/, method: 'PATCH', status: 422, body: {} },
    ])
    expect(await new GitHubTransport(cfg, miss).updateRef('new')).toBe(false)
  })

  it('createRef returns true on 201 and false on 422 (the branch already exists)', async () => {
    const ok = makeFakeFetch([{ url: /git\/refs$/, method: 'POST', status: 201, body: {} }])
    expect(await new GitHubTransport(cfg, ok).createRef('new')).toBe(true)
    const taken = makeFakeFetch([
      {
        url: /git\/refs$/,
        method: 'POST',
        status: 422,
        body: { message: 'Reference already exists' },
      },
    ])
    expect(await new GitHubTransport(cfg, taken).createRef('new')).toBe(false)
  })

  it('listTree returns blob entries only, from the recursive listing', async () => {
    const fetchFn = makeFakeFetch([
      {
        url: /git\/trees\/t1\?recursive=1/,
        method: 'GET',
        status: 200,
        body: {
          tree: [
            { path: 'data', type: 'tree', sha: 'd' },
            { path: 'data/tags-0001.csv', type: 'blob', sha: 'b1' },
          ],
          truncated: false,
        },
      },
    ])
    expect(await new GitHubTransport(cfg, fetchFn).listTree('t1')).toEqual([
      { path: 'data/tags-0001.csv', sha: 'b1' },
    ])
  })

  it('listTree throws when GitHub truncates the listing', async () => {
    const fetchFn = makeFakeFetch([
      {
        url: /git\/trees\/t1\?recursive=1/,
        method: 'GET',
        status: 200,
        body: { tree: [], truncated: true },
      },
    ])
    await expect(new GitHubTransport(cfg, fetchFn).listTree('t1')).rejects.toThrow(/truncated/)
  })

  it('getBlob decodes base64 UTF-8 content', async () => {
    const text = 'Café ✈️\n'
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    const fetchFn = makeFakeFetch([
      {
        url: /git\/blobs\/b1$/,
        method: 'GET',
        status: 200,
        body: { content: b64.match(/.{1,60}/g)!.join('\n'), encoding: 'base64' },
      },
    ])
    expect(await new GitHubTransport(cfg, fetchFn).getBlob('b1')).toBe(text)
  })

  it('sends Authorization: Bearer on every request', async () => {
    let seenAuth: string | undefined
    const captureFetch: GitHubFetch = async (_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)?.['Authorization']
      return new Response(JSON.stringify({ name: 'mt' }), { status: 200 })
    }
    await new GitHubTransport(cfg, captureFetch).validate()
    expect(seenAuth).toBe('Bearer ghp_test')
  })
})
