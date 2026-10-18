import { describe, it, expect, afterEach } from 'vitest'
import { computed } from 'vue'
import { applyProviderConfig, getSyncBackend, setSyncBackend } from '../init'
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
