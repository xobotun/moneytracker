import { describe, it, expect } from 'vitest'
import { withSyncFetchPolicy } from '../fetchPolicy'
import { GitHubTransport } from '../GitHubTransport'
import { SupabaseStorageTransport } from '../SupabaseStorageTransport'
import { S3Transport } from '../S3Transport'

/** A fetch that records each call's init and always answers 404. */
function recordingFetch() {
  const inits: Array<RequestInit | undefined> = []
  const fetchFn: typeof fetch = async (_input, init) => {
    inits.push(init)
    return new Response(null, { status: 404 })
  }
  return { inits, fetchFn }
}

describe('withSyncFetchPolicy', () => {
  it('bypasses the HTTP cache and attaches a timeout signal', async () => {
    const { inits, fetchFn } = recordingFetch()
    await withSyncFetchPolicy(fetchFn)('https://example.com', { method: 'GET' })
    expect(inits[0]!.cache).toBe('no-store')
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(inits[0]!.method).toBe('GET')
  })

  it("keeps a caller's own abort signal", async () => {
    const { inits, fetchFn } = recordingFetch()
    const own = new AbortController().signal
    await withSyncFetchPolicy(fetchFn)('https://example.com', { signal: own })
    expect(inits[0]!.signal).toBe(own)
  })

  it('aborts a request that outlives the timeout', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
    await expect(withSyncFetchPolicy(hanging, 10)('https://example.com')).rejects.toThrow()
  })
})

describe('transports apply the sync fetch policy', () => {
  it('GitHubTransport', async () => {
    const { inits, fetchFn } = recordingFetch()
    const t = new GitHubTransport({ repo: 'me/mt', branch: 'main', token: 't' }, fetchFn)
    await t.getRef()
    expect(inits[0]!.cache).toBe('no-store')
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it('SupabaseStorageTransport', async () => {
    const { inits, fetchFn } = recordingFetch()
    const cfg = { url: 'https://p.supabase.co', anonKey: 'k', bucket: 'b' }
    await new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn).getSidecar()
    expect(inits[0]!.cache).toBe('no-store')
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it('S3Transport', async () => {
    const { inits, fetchFn } = recordingFetch()
    const cfg = {
      endpoint: 'https://r2.example.com',
      region: 'auto',
      accessKeyId: 'AK',
      secretKey: 'SK',
      bucket: 'mt',
      objectKey: 'db.sqlite',
    }
    await new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn).getSidecar()
    expect(inits[0]!.cache).toBe('no-store')
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal)
  })
})
