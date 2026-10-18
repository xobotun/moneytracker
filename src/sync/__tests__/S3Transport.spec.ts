import { describe, it, expect } from 'vitest'
import { S3Transport } from '../S3Transport'

// aws4fetch.AwsClient wraps fetch under the hood; we intercept at the
// fetch layer (passed as ctor argument) to assert on requests without
// signing complexity.

const cfg = {
  endpoint: 'https://r2.example.com',
  region: 'auto',
  accessKeyId: 'AK',
  secretKey: 'SK',
  bucket: 'mt',
  objectKey: 'db.sqlite',
}

function captureFetch() {
  const calls: Array<{
    url: string
    method: string
    headers: Record<string, string>
    body: BodyInit | null
  }> = []
  const fetchFn: typeof fetch = async (url, init) => {
    const req = url instanceof Request ? url : new Request(url, init)
    calls.push({
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers.entries()),
      body: init?.body ?? null,
    })
    if (req.method === 'GET' && req.url.endsWith('/db.sqlite.json')) {
      return new Response('{"device":"x"}', {
        status: 200,
        headers: { etag: '"abc"', 'content-type': 'application/json' },
      })
    }
    return new Response(null, { status: 200, headers: { etag: '"xyz"' } })
  }
  return { calls, fetchFn }
}

describe('S3Transport', () => {
  it('getSidecar returns text + etag on 200', async () => {
    const { fetchFn } = captureFetch()
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    expect(await t.getSidecar()).toEqual({ text: '{"device":"x"}', etag: '"abc"' })
  })

  it('getSidecar returns null on 404', async () => {
    const fetchFn: typeof fetch = async () => new Response(null, { status: 404 })
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    expect(await t.getSidecar()).toBeNull()
  })

  it('putSidecar(null) sends If-None-Match: *', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.putSidecar('{}', null)
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('db.sqlite.json'))!
    expect(put.headers['if-none-match']).toBe('*')
  })

  it('putSidecar(etag) sends If-Match: <etag>', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.putSidecar('{}', '"abc"')
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('db.sqlite.json'))!
    expect(put.headers['if-match']).toBe('"abc"')
  })

  it('putSidecar returns false on 412', async () => {
    const fetchFn: typeof fetch = async () => new Response(null, { status: 412 })
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    expect(await t.putSidecar('{}', '"stale"')).toBe(false)
  })

  it('signed requests carry Authorization with AWS4-HMAC-SHA256', async () => {
    const { fetchFn, calls } = captureFetch()
    const t = new S3Transport(cfg, 'db.sqlite', 'db.sqlite.json', fetchFn)
    await t.validate()
    const auth = calls[0]!.headers['authorization']
    expect(auth).toMatch(/^AWS4-HMAC-SHA256/)
  })
})
