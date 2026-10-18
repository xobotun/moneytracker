import { describe, it, expect, beforeEach, vi } from 'vitest'
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
      github: { repo: 'me/mt', branch: 'main', token: 'ghp_x' },
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

  describe('robustness against bad or unavailable storage', () => {
    it('does not let edits to a loaded config leak into the defaults', () => {
      const cfg = loadProviderConfig()
      cfg.github.repo = 'me/edited'
      expect(EMPTY_PROVIDER_CONFIG.github.repo).toBe('')
      expect(loadProviderConfig().github.repo).toBe('')
    })

    it('falls back to the default block when a stored provider block is not an object', () => {
      localStorage.setItem('moneytracker.sync.providerConfig', JSON.stringify({ active: 's3', s3: null }))
      expect(loadProviderConfig().s3).toEqual(EMPTY_PROVIDER_CONFIG.s3)
    })

    it('fills fields missing from a stored provider block from the defaults', () => {
      localStorage.setItem(
        'moneytracker.sync.providerConfig',
        JSON.stringify({ active: 's3', s3: { endpoint: 'https://r2.example.com' } }),
      )
      const cfg = loadProviderConfig()
      expect(cfg.s3.endpoint).toBe('https://r2.example.com')
      expect(cfg.s3.region).toBe(EMPTY_PROVIDER_CONFIG.s3.region)
    })

    it('treats an unknown active provider as "none"', () => {
      localStorage.setItem('moneytracker.sync.providerConfig', JSON.stringify({ active: 'ftp' }))
      expect(loadProviderConfig().active).toBe('none')
    })

    it('returns the defaults when localStorage cannot be read (e.g. blocked storage)', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError')
      })
      try {
        expect(loadProviderConfig()).toEqual(EMPTY_PROVIDER_CONFIG)
      } finally {
        spy.mockRestore()
      }
    })
  })
})
