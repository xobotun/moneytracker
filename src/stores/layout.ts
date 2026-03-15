import { type Ref, ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { getSettingsRepository } from '@/db/init'
import type { SettingsKey } from '@/db/SettingsKey'
import { LayoutKeys, type NavPosition, type CollapseMode, type ThemePreset } from './layout-types'

export { type NavPosition, type CollapseMode, type ThemePreset } from './layout-types'

/** Load a persisted value into a ref. No-op if the key doesn't exist in the DB. */
async function hydrateRef<T>(key: SettingsKey<T>, target: Ref<T>): Promise<void> {
  const stored = await getSettingsRepository().get(key)
  if (stored !== null) target.value = stored
}

/** Persist a value, then update the ref (write-through). */
async function persistRef<T>(key: SettingsKey<T>, target: Ref<T>, value: T): Promise<void> {
  await getSettingsRepository().set(key, value)
  target.value = value
}

const MOBILE_BREAKPOINT = 768

export const useLayoutStore = defineStore('layout', () => {
  const navPosition = ref<NavPosition>('auto')
  const collapseMode = ref<CollapseMode>('opens-on-hover')
  const isDark = ref(false)
  const themePreset = ref<ThemePreset>('Aura')
  const isTemporarilyToggled = ref(false)

  const navItems = ref([
    { label: 'Home', icon: 'pi pi-home', route: '/' },
    { label: 'Page Two', icon: 'pi pi-file', route: '/page-two' },
    { label: 'About', icon: 'pi pi-info-circle', route: '/about' },
  ])

  async function hydrate(): Promise<void> {
    await Promise.all([
      hydrateRef(LayoutKeys.navPosition, navPosition),
      hydrateRef(LayoutKeys.collapseMode, collapseMode),
      hydrateRef(LayoutKeys.isDark, isDark),
      hydrateRef(LayoutKeys.themePreset, themePreset),
    ])
  }

  async function setNavPosition(value: NavPosition): Promise<void> {
    await persistRef(LayoutKeys.navPosition, navPosition, value)
  }

  async function setCollapseMode(value: CollapseMode): Promise<void> {
    await persistRef(LayoutKeys.collapseMode, collapseMode, value)
  }

  async function setDarkMode(value: boolean): Promise<void> {
    await persistRef(LayoutKeys.isDark, isDark, value)
    document.documentElement.classList.toggle('dark', value)
  }

  async function setThemePreset(value: ThemePreset): Promise<void> {
    await persistRef(LayoutKeys.themePreset, themePreset, value)
  }

  function effectivePosition(windowWidth: number): Exclude<NavPosition, 'auto'> {
    if (navPosition.value !== 'auto') {
      return navPosition.value
    }
    return windowWidth >= MOBILE_BREAKPOINT ? 'left' : 'top'
  }

  const isVertical = computed(() => {
    return navPosition.value === 'left' || navPosition.value === 'right'
  })

  return {
    navPosition,
    collapseMode,
    isDark,
    themePreset,
    isTemporarilyToggled,
    navItems,
    hydrate,
    setNavPosition,
    setCollapseMode,
    setDarkMode,
    setThemePreset,
    effectivePosition,
    isVertical,
  }
})
