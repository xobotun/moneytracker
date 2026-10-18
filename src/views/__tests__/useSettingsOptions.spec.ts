import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSettingsOptions } from '../useSettingsOptions'
import { useLayoutStore } from '@/stores/layout'

const writeMode = { value: 'ok' as 'ok' | 'fail' }
vi.mock('@/db/init', () => ({
  getSettingsRepository: () => ({
    get: async () => null,
    set: async () => {
      if (writeMode.value === 'fail') throw new Error('disk full')
    },
  }),
}))

const appliedPresets: unknown[] = []
vi.mock('@primeuix/themes', () => ({
  usePreset: (preset: unknown) => appliedPresets.push(preset),
}))

/** Lets the store's rejected save settle and the composable's catch run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useSettingsOptions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    writeMode.value = 'ok'
    appliedPresets.length = 0
  })

  it('selects reflect the store, including changes made elsewhere', async () => {
    const options = useSettingsOptions()
    await useLayoutStore().setNavPosition('left')
    expect(options.selectedNavPosition.value.value).toBe('left')
  })

  it('choosing an option updates the store immediately', () => {
    const options = useSettingsOptions()
    options.selectedCollapseMode.value = options.collapseModeOptions[0]!
    expect(useLayoutStore().collapseMode).toBe('always-collapsed')
  })

  it('reverts the choice and shows an error when saving fails', async () => {
    writeMode.value = 'fail'
    const options = useSettingsOptions()
    options.selectedNavPosition.value = options.navPositionOptions.find((o) => o.value === 'top')!
    await settle()
    expect(options.selectedNavPosition.value.value).toBe('auto')
    expect(options.saveError.value).toMatch(/disk full/)
  })

  it('re-applies the previous theme preset when saving the new one fails', async () => {
    writeMode.value = 'fail'
    const options = useSettingsOptions()
    const aura = options.themePresetOptions.find((p) => p.name === 'Aura')!
    const lara = options.themePresetOptions.find((p) => p.name === 'Lara')!
    options.selectedPreset.value = lara
    await settle()
    expect(appliedPresets).toEqual([lara.preset, aura.preset])
    expect(options.selectedPreset.value.name).toBe('Aura')
  })

  it('clears a previous error after a successful save', async () => {
    writeMode.value = 'fail'
    const options = useSettingsOptions()
    await options.onDarkModeChange(true)
    expect(options.saveError.value).not.toBeNull()
    writeMode.value = 'ok'
    await options.onDarkModeChange(true)
    expect(options.saveError.value).toBeNull()
  })
})
