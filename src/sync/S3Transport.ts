import { AwsClient } from 'aws4fetch'
import type { BlobTransport } from './BlobTransport'
import type { S3Config } from './localState/providerConfig'

type FetchFn = typeof fetch

/**
 * S3-compatible BlobTransport using aws4fetch for AWS Signature v4 signing.
 * Works against AWS S3, Cloudflare R2, Backblaze B2, MinIO.
 *
 * The installed aws4fetch (1.0.20) AwsClient constructor does NOT accept a
 * `fetch` option — its constructor destructures only
 * { accessKeyId, secretAccessKey, sessionToken, service, region, cache,
 * retries, initRetryMs } — and its own `.fetch()` method calls the global
 * `fetch` directly rather than an injectable one. So requests are signed
 * manually via `client.sign(url, init)` (which returns a signed `Request`)
 * and dispatched through the injected fetchFn ourselves. This keeps the
 * class testable without a real network layer, mirroring
 * SupabaseStorageTransport's injectable-fetch pattern.
 *
 * Endpoint shape: {endpoint}/{bucket}/{key}. `endpoint` is the bucket-style
 * or virtual-host-style URL prefix from S3Config; S3-compat backends accept
 * both.
 * CAS: If-Match / If-None-Match on the sidecar PUT; 412 → CAS miss.
 */
export class S3Transport implements BlobTransport {
  private readonly client: AwsClient

  constructor(
    private readonly cfg: S3Config,
    private readonly blobKey: string,
    private readonly sidecarKey: string,
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  ) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretKey,
      region: cfg.region,
      service: 's3',
    })
  }

  async validate(): Promise<void> {
    const res = await this.signedFetch(this.url(this.sidecarKey), { method: 'HEAD' })
    if (res.status === 401 || res.status === 403) {
      throw new Error(`S3Transport.validate: auth failed (${res.status})`)
    }
    // 200 or 404 are both fine — they confirm the endpoint is reachable and auth works.
  }

  async getSidecar(): Promise<{ text: string; etag: string } | null> {
    const res = await this.signedFetch(this.url(this.sidecarKey), { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`S3Transport.getSidecar: ${res.status}`)
    const text = await res.text()
    const etag = res.headers.get('etag') ?? ''
    return { text, etag }
  }

  async putBlob(bytes: Uint8Array): Promise<void> {
    const res = await this.signedFetch(this.url(this.blobKey), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      // See SupabaseStorageTransport for why this cast is needed: the
      // tsconfig's `"types": ["node"]` pulls in @types/node's
      // Uint8Array<ArrayBufferLike> global, which doesn't structurally
      // satisfy lib.dom's BodyInit. Runtime behavior is unaffected.
      body: bytes as BodyInit,
    })
    if (!res.ok) throw new Error(`S3Transport.putBlob: ${res.status}`)
  }

  async putSidecar(text: string, expectedEtag: string | null): Promise<boolean> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (expectedEtag === null) headers['if-none-match'] = '*'
    else headers['if-match'] = expectedEtag

    const res = await this.signedFetch(this.url(this.sidecarKey), {
      method: 'PUT',
      headers,
      body: text,
    })
    if (res.status === 412) return false
    if (!res.ok) throw new Error(`S3Transport.putSidecar: ${res.status}`)
    return true
  }

  async getBlob(): Promise<Uint8Array> {
    const res = await this.signedFetch(this.url(this.blobKey), { method: 'GET' })
    if (!res.ok) throw new Error(`S3Transport.getBlob: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  /** Sign a request with sig v4, then dispatch it through the injected fetchFn. */
  private async signedFetch(url: string, init: RequestInit): Promise<Response> {
    const signed = await this.client.sign(url, init)
    return this.fetchFn(signed)
  }

  private url(key: string): string {
    return `${this.cfg.endpoint.replace(/\/$/, '')}/${this.cfg.bucket}/${encodeURIComponent(key)}`
  }
}
