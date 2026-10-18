import { ref, computed } from 'vue'
import { usePreset } from '@primeuix/themes'
import { useLayoutStore } from '@/stores/layout'
import { themePresets, type NavPosition, type CollapseMode, type ThemePreset } from '@/stores/layout-types'
import type { Preset } from '@primeuix/themes/types'

interface SelectOption<T> {
  name: string
  value: T
}

interface PresetOption {
  name: ThemePreset
  preset: Preset
}

function findOrFirst<T>(options: T[], predicate: (o: T) => boolean): T {
  return options.find(predicate) ?? options[0]!
}

export function useSettingsOptions() {
  const layoutStore = useLayoutStore()

  // Visual settings save optimistically (the store applies the new value at
  // once and reverts it if persisting fails). This shows why it reverted.
  const saveError = ref<string | null>(null)

  async function save(action: () => Promise<void>): Promise<void> {
    try {
      await action()
      saveError.value = null
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      saveError.value = `Could not save the setting (${reason}); it was changed back.`
    }
  }

  // The selects are computed views of the store, not copies of it: a get/set
  // `computed` reads the store on every render, so a revert (or a change made
  // elsewhere) shows up in the select automatically. Its setter is what
  // v-model calls when the user picks an option.

  // --- Theme preset ---
  const themePresetOptions: PresetOption[] = (Object.keys(themePresets) as ThemePreset[]).map(
    (name) => ({ name, preset: themePresets[name] }),
  )
  const selectedPreset = computed<PresetOption>({
    get: () => findOrFirst(themePresetOptions, (p) => p.name === layoutStore.themePreset),
    set: (option) => {
      const previous = themePresets[layoutStore.themePreset]
      usePreset(option.preset)
      void save(async () => {
        try {
          await layoutStore.setThemePreset(option.name)
        } catch (e) {
          usePreset(previous) // the store reverted its value; revert the applied theme too
          throw e
        }
      })
    },
  })

  // --- Dark mode ---
  async function onDarkModeChange(value: boolean) {
    await save(() => layoutStore.setDarkMode(value))
  }

  // --- Nav position ---
  const navPositionOptions: SelectOption<NavPosition>[] = [
    { name: 'Auto (responsive)', value: 'auto' },
    { name: 'Top', value: 'top' },
    { name: 'Bottom', value: 'bottom' },
    { name: 'Left', value: 'left' },
    { name: 'Right', value: 'right' },
  ]
  const selectedNavPosition = computed<SelectOption<NavPosition>>({
    get: () => findOrFirst(navPositionOptions, (o) => o.value === layoutStore.navPosition),
    set: (option) => void save(() => layoutStore.setNavPosition(option.value)),
  })

  // --- Collapse mode ---
  const collapseModeOptions: SelectOption<CollapseMode>[] = [
    { name: 'Always collapsed', value: 'always-collapsed' },
    { name: 'Opens on hover', value: 'opens-on-hover' },
    { name: 'Always expanded', value: 'always-expanded' },
  ]
  const selectedCollapseMode = computed<SelectOption<CollapseMode>>({
    get: () => findOrFirst(collapseModeOptions, (o) => o.value === layoutStore.collapseMode),
    set: (option) => void save(() => layoutStore.setCollapseMode(option.value)),
  })

  const showCollapseMode = computed(() => {
    const pos = layoutStore.navPosition
    return pos === 'left' || pos === 'right' || pos === 'auto'
  })

  return {
    layoutStore,
    saveError,
    themePresetOptions,
    selectedPreset,
    onDarkModeChange,
    navPositionOptions,
    selectedNavPosition,
    collapseModeOptions,
    selectedCollapseMode,
    showCollapseMode,
  }
}
