import { describe, it, expect } from 'vitest'
import { buildBackend } from '../backendFactory'
import { GitHubCsvBackend } from '../GitHubCsvBackend'
import { SqliteBlobBackend } from '../SqliteBlobBackend'
import { EMPTY_PROVIDER_CONFIG } from '../localState/providerConfig'

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
})
