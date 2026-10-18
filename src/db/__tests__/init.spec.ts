import { describe, it, expect, afterEach, vi } from 'vitest'
import { computed } from 'vue'
import {
  applyProviderConfig,
  applyStoredProviderConfig,
  getSyncBackend,
  setSyncBackend,
} from '../init'
import { EMPTY_PROVIDER_CONFIG, type ProviderConfig } from '../../sync/localState'

const GITHUB_CONFIG: ProviderConfig = {
  ...EMPTY_PROVIDER_CONFIG,
  active: 'github',
  github: { repo: 'me/mt', branch: 'main', token: 't' },
}

describe('sync backend registry', () => {
  afterEach(() => {
    setSyncBackend(null)
  })

  it('is reactive, so UI state derived from it follows provider switches', () => {
    const available = computed(() => getSyncBackend() !== null)
    expect(available.value).toBe(false)
    applyProviderConfig(GITHUB_CONFIG)
    expect(available.value).toBe(true)
    applyProviderConfig({ ...GITHUB_CONFIG, active: 'none' })
    expect(available.value).toBe(false)
  })
})

describe('applyStoredProviderConfig (app startup)', () => {
  afterEach(() => {
    setSyncBackend(null)
    vi.restoreAllMocks()
  })

  it('does not throw, and leaves sync off, when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(() => applyStoredProviderConfig()).not.toThrow()
    expect(getSyncBackend()).toBeNull()
  })

  it('does not throw, and leaves sync off, when loading or building fails for any reason', () => {
    applyProviderConfig(GITHUB_CONFIG) // a previously registered backend must not survive
    const failingLoad = (): ProviderConfig => {
      throw new Error('corrupt config')
    }
    expect(() => applyStoredProviderConfig(failingLoad)).not.toThrow()
    expect(getSyncBackend()).toBeNull()
  })
})
