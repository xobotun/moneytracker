import { describe, it, expect } from 'vitest'
import { SupabaseStorageTransport } from '../SupabaseStorageTransport'

type Captured = {
  url: string
  method: string
  headers: Record<string, string>
  body: BodyInit | null
}

function captureFetch() {
  const calls: Captured[] = []
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    })
    if (calls[calls.length - 1]!.method === 'GET' && url.toString().endsWith('/db.sqlite.json')) {
      return new Response('{"device":"x"}', {
        status: 200,
        headers: { etag: '"abc"', 'content-type': 'application/json' },
      })
    }
    return new Response(null, { status: 200, headers: { etag: '"xyz"' } })
  }
  return { calls, fetchFn }
}

const cfg = {
  url: 'https://proj.supabase.co',
  anonKey: 'eyJ...',
  bucket: 'moneytracker',
}

describe('SupabaseStorageTransport', () => {
  it('getSidecar reads JSON and parses the ETag', async () => {
    const { fetchFn } = captureFetch()
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    const got = await t.getSidecar()
    expect(got).toEqual({ text: '{"device":"x"}', etag: '"abc"' })
  })

  it('putSidecar with expectedEtag === null sends If-None-Match: *', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.putSidecar('{}', null)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.headers['If-None-Match']).toBe('*')
  })

  it('putSidecar with expectedEtag sends If-Match: <etag>', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.putSidecar('{}', '"abc"')
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.headers['If-Match']).toBe('"abc"')
  })

  it('putSidecar returns false on 412', async () => {
    const fetchFn: typeof fetch = async () => new Response(null, { status: 412 })
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    expect(await t.putSidecar('{}', '"stale"')).toBe(false)
  })

  it('every request carries the apikey + Authorization headers', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new SupabaseStorageTransport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.validate()
    const c = calls[0]!
    expect(c.headers['apikey']).toBe('eyJ...')
    expect(c.headers['Authorization']).toBe('Bearer eyJ...')
  })
})
