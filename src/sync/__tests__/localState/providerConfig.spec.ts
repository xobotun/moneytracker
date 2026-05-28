import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadProviderConfig,
  saveProviderConfig,
  EMPTY_PROVIDER_CONFIG,
  type ProviderConfig,
} from '../../localState/providerConfig'

describe('providerConfig', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns EMPTY_PROVIDER_CONFIG when nothing is stored', () => {
    expect(loadProviderConfig()).toEqual(EMPTY_PROVIDER_CONFIG)
  })

  it('EMPTY_PROVIDER_CONFIG has sensible defaults', () => {
    expect(EMPTY_PROVIDER_CONFIG.active).toBe('none')
    expect(EMPTY_PROVIDER_CONFIG.supabase.bucket).toBe('moneytracker')
    expect(EMPTY_PROVIDER_CONFIG.s3.objectKey).toBe('moneytracker.sqlite')
    expect(EMPTY_PROVIDER_CONFIG.github.branch).toBe('main')
    expect(EMPTY_PROVIDER_CONFIG.github.path).toBe('moneytracker.sqlite')
  })

  it('round-trips a fully populated config', () => {
    const cfg: ProviderConfig = {
      active: 's3',
      supabase: { url: 'https://x.supabase.co', anonKey: 'sb-key', bucket: 'mt' },
      s3: {
        endpoint: 'https://s3',
        region: 'auto',
        accessKeyId: 'AK',
        secretKey: 'SK',
        bucket: 'mt',
        objectKey: 'db.sqlite',
      },
      github: { repo: 'me/mt', branch: 'main', path: 'db.sqlite', token: 'ghp_x' },
    }
    saveProviderConfig(cfg)
    expect(loadProviderConfig()).toEqual(cfg)
  })

  it('merges a partial stored config over EMPTY_PROVIDER_CONFIG (forward compat)', () => {
    // Simulates a stored payload from a future or past build that only set
    // `active` and a partial supabase block. The load must fill in the rest
    // from the empty default so a missing field never throws downstream.
    localStorage.setItem(
      'moneytracker.sync.providerConfig',
      JSON.stringify({ active: 'supabase', supabase: { url: 'u', anonKey: 'k', bucket: 'b' } }),
    )
    const cfg = loadProviderConfig()
    expect(cfg.active).toBe('supabase')
    expect(cfg.supabase).toEqual({ url: 'u', anonKey: 'k', bucket: 'b' })
    // The unset blocks fall back to the empty defaults.
    expect(cfg.s3).toEqual(EMPTY_PROVIDER_CONFIG.s3)
    expect(cfg.github).toEqual(EMPTY_PROVIDER_CONFIG.github)
  })
})
