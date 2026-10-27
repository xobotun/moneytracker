import { describe, it, expect } from 'vitest'
import { buildBackend } from '../backendFactory'
import { GitHubCsvBackend } from '../GitHubCsvBackend'
import { SqliteBlobBackend } from '../SqliteBlobBackend'
import { EMPTY_PROVIDER_CONFIG, type ProviderConfig } from '../localState/providerConfig'

describe('buildBackend', () => {
  it('returns null when active is "none"', () => {
    expect(buildBackend({ ...EMPTY_PROVIDER_CONFIG, active: 'none' })).toBeNull()
  })

  it('returns a GitHubCsvBackend when active is "github"', () => {
    const cfg = {
      ...EMPTY_PROVIDER_CONFIG,
      active: 'github' as const,
      github: { repo: 'me/mt', branch: 'main', token: 'ghp_x' },
    }
    expect(buildBackend(cfg)).toBeInstanceOf(GitHubCsvBackend)
  })

  it('returns a SqliteBlobBackend when active is "supabase"', () => {
    const cfg = {
      ...EMPTY_PROVIDER_CONFIG,
      active: 'supabase' as const,
      supabase: { url: 'https://p.supabase.co', anonKey: 'k', bucket: 'mt' },
    }
    expect(buildBackend(cfg)).toBeInstanceOf(SqliteBlobBackend)
  })

  it('returns a SqliteBlobBackend when active is "s3"', () => {
    const cfg = {
      ...EMPTY_PROVIDER_CONFIG,
      active: 's3' as const,
      s3: {
        endpoint: 'https://s3',
        region: 'auto',
        accessKeyId: 'AK',
        secretKey: 'SK',
        bucket: 'mt',
        objectKey: 'db.sqlite',
      },
    }
    expect(buildBackend(cfg)).toBeInstanceOf(SqliteBlobBackend)
  })

  it('names each remote by where its data lives, without a token or key', () => {
    const github = buildBackend({
      ...EMPTY_PROVIDER_CONFIG,
      active: 'github',
      github: { repo: 'me/mt', branch: 'data', token: 'ghp_secret' },
    })!
    expect(github.remoteId).toBe('github:me/mt@data')

    const supabase = buildBackend({
      ...EMPTY_PROVIDER_CONFIG,
      active: 'supabase',
      supabase: { url: 'https://p.supabase.co', anonKey: 'anon-secret', bucket: 'mt' },
    })!
    expect(supabase.remoteId).toBe('supabase:https://p.supabase.co/mt/db.sqlite')

    const s3 = buildBackend({
      ...EMPTY_PROVIDER_CONFIG,
      active: 's3',
      s3: {
        endpoint: 'https://s3.example.com',
        region: 'auto',
        accessKeyId: 'access-secret',
        secretKey: 'key-secret',
        bucket: 'mt',
        objectKey: 'money.sqlite',
      },
    })!
    expect(s3.remoteId).toBe('s3:https://s3.example.com/mt/money.sqlite')

    for (const backend of [github, supabase, s3]) expect(backend.remoteId).not.toMatch(/secret/)
  })

  it('returns null for an unknown provider kind (e.g. a config written by a newer build)', () => {
    const cfg = { ...EMPTY_PROVIDER_CONFIG, active: 'ftp' } as unknown as ProviderConfig
    expect(buildBackend(cfg)).toBeNull()
  })
})
