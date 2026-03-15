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

  // --- Theme preset ---
  const themePresetOptions: PresetOption[] = (Object.keys(themePresets) as ThemePreset[]).map(
    (name) => ({ name, preset: themePresets[name] }),
  )
  const selectedPreset = ref<PresetOption>(
    findOrFirst(themePresetOptions, (p) => p.name === layoutStore.themePreset),
  )
  async function onPresetChange() {
    usePreset(selectedPreset.value.preset)
    await layoutStore.setThemePreset(selectedPreset.value.name)
  }

  // --- Dark mode ---
  async function onDarkModeChange(value: boolean) {
    await layoutStore.setDarkMode(value)
  }

  // --- Nav position ---
  const navPositionOptions: SelectOption<NavPosition>[] = [
    { name: 'Auto (responsive)', value: 'auto' },
    { name: 'Top', value: 'top' },
    { name: 'Bottom', value: 'bottom' },
    { name: 'Left', value: 'left' },
    { name: 'Right', value: 'right' },
  ]
  const selectedNavPosition = ref<SelectOption<NavPosition>>(
    findOrFirst(navPositionOptions, (o) => o.value === layoutStore.navPosition),
  )
  async function onNavPositionChange() {
    await layoutStore.setNavPosition(selectedNavPosition.value.value)
  }

  // --- Collapse mode ---
  const collapseModeOptions: SelectOption<CollapseMode>[] = [
    { name: 'Always collapsed', value: 'always-collapsed' },
    { name: 'Opens on hover', value: 'opens-on-hover' },
    { name: 'Always expanded', value: 'always-expanded' },
  ]
  const selectedCollapseMode = ref<SelectOption<CollapseMode>>(
    findOrFirst(collapseModeOptions, (o) => o.value === layoutStore.collapseMode),
  )
  async function onCollapseModeChange() {
    await layoutStore.setCollapseMode(selectedCollapseMode.value.value)
  }

  const showCollapseMode = computed(() => {
    const pos = layoutStore.navPosition
    return pos === 'left' || pos === 'right' || pos === 'auto'
  })

  return {
    layoutStore,
    themePresetOptions,
    selectedPreset,
    onPresetChange,
    onDarkModeChange,
    navPositionOptions,
    selectedNavPosition,
    onNavPositionChange,
    collapseModeOptions,
    selectedCollapseMode,
    onCollapseModeChange,
    showCollapseMode,
  }
}
