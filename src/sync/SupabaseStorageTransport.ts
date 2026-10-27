import type { BlobTransport } from './BlobTransport'
import type { SupabaseConfig } from './localState/providerConfig'
import { withSyncFetchPolicy } from './fetchPolicy'

type FetchFn = typeof fetch

/**
 * Supabase Storage implementation of BlobTransport.
 *
 * Endpoint shape: {supabaseUrl}/storage/v1/object/{bucket}/{key}
 * Auth: anon key in both `apikey` and `Authorization: Bearer` headers
 *       (Supabase's storage gateway expects both).
 * CAS: standard HTTP conditional headers — If-Match / If-None-Match — on
 *      the sidecar PUT. The gateway returns 412 on mismatch.
 *
 * No @supabase/storage-js dependency; fetch directly so we control headers
 * and don't add 200KB of SDK to the bundle for two endpoints.
 */
export class SupabaseStorageTransport implements BlobTransport {
  private readonly fetch: FetchFn

  constructor(
    private readonly cfg: SupabaseConfig,
    private readonly blobKey: string,
    private readonly sidecarKey: string,
    fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  ) {
    this.fetch = withSyncFetchPolicy(fetchFn)
  }

  /** Without the anon key. */
  get remoteId(): string {
    return `supabase:${this.cfg.url}/${this.cfg.bucket}/${this.blobKey}`
  }

  async validate(): Promise<void> {
    // HEAD on the bucket root would be ideal but Supabase Storage doesn't
    // expose it directly; a HEAD on any object path returns 404 vs. 401
    // and lets us prove auth works.
    const res = await this.fetch(this.url(this.sidecarKey), {
      method: 'HEAD',
      headers: this.authHeaders(),
    })
    if (res.status === 401 || res.status === 403) {
      throw new Error(`SupabaseStorageTransport.validate: auth failed (${res.status})`)
    }
    // 200 or 404 are both fine — they confirm the endpoint reachable + auth ok.
  }

  async getSidecar(): Promise<{ text: string; etag: string } | null> {
    const res = await this.fetch(this.url(this.sidecarKey), {
      method: 'GET',
      headers: this.authHeaders(),
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`SupabaseStorageTransport.getSidecar: ${res.status}`)
    const text = await res.text()
    const etag = res.headers.get('etag') ?? ''
    return { text, etag }
  }

  async putBlob(bytes: Uint8Array): Promise<void> {
    const res = await this.fetch(this.url(this.blobKey), {
      method: 'PUT',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/octet-stream',
      },
      // The tsconfig's `"types": ["node"]` (needed elsewhere for wa-sqlite)
      // pulls in @types/node's Uint8Array<ArrayBufferLike> global, which
      // doesn't structurally satisfy lib.dom's BodyInit (ArrayBufferView
      // over a concrete ArrayBuffer). Runtime behavior is unaffected —
      // fetch accepts any Uint8Array — so this is a type-only cast.
      body: bytes as BodyInit,
    })
    if (!res.ok) throw new Error(`SupabaseStorageTransport.putBlob: ${res.status}`)
  }

  async putSidecar(text: string, expectedEtag: string | null): Promise<boolean> {
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      'Content-Type': 'application/json',
    }
    if (expectedEtag === null) headers['If-None-Match'] = '*'
    else headers['If-Match'] = expectedEtag

    const res = await this.fetch(this.url(this.sidecarKey), {
      method: 'PUT',
      headers,
      body: text,
    })
    if (res.status === 412) return false
    if (!res.ok) throw new Error(`SupabaseStorageTransport.putSidecar: ${res.status}`)
    return true
  }

  async getBlob(): Promise<Uint8Array> {
    const res = await this.fetch(this.url(this.blobKey), {
      method: 'GET',
      headers: this.authHeaders(),
    })
    if (!res.ok) throw new Error(`SupabaseStorageTransport.getBlob: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  private url(key: string): string {
    return `${this.cfg.url.replace(/\/$/, '')}/storage/v1/object/${this.cfg.bucket}/${encodeURIComponent(key)}`
  }

  private authHeaders(): Record<string, string> {
    return {
      apikey: this.cfg.anonKey,
      Authorization: `Bearer ${this.cfg.anonKey}`,
    }
  }
}
