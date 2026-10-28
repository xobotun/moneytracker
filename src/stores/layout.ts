import { type Ref, ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { getSettingsRepository } from '@/db/init'
import type { SettingsKey } from '@/db/SettingsKey'
import {
  LayoutKeys,
  isBoolean,
  isCollapseMode,
  isLocationsView,
  isNavPosition,
  isTagRowStyle,
  isThemePreset,
  type NavPosition,
  type CollapseMode,
  type LocationsView,
  type TagRowStyle,
  type ThemePreset,
} from './layout-types'

export {
  type NavPosition,
  type CollapseMode,
  type LocationsView,
  type TagRowStyle,
  type ThemePreset,
} from './layout-types'

/**
 * Load a persisted value into a ref. Keeps the default when the key doesn't
 * exist or the stored value is not valid (stale or corrupt) — an unknown
 * theme name, for instance, would otherwise break app startup.
 */
async function hydrateRef<T>(
  key: SettingsKey<T>,
  target: Ref<T>,
  isValid: (value: unknown) => value is T,
): Promise<void> {
  const stored: unknown = await getSettingsRepository().get(key)
  if (stored === null) return
  if (isValid(stored)) target.value = stored
  else console.warn(`Ignoring invalid stored setting ${key.key}:`, stored)
}

/**
 * Optimistic save for visual settings: show the new value right away, then
 * persist; if persisting fails, put the old value back and rethrow so the UI
 * can say so. `apply` mirrors the value outside the store (e.g. a CSS class)
 * and is re-run with the old value on revert.
 *
 * Deliberately NOT the pattern for financial data, which stays write-through
 * (persist first, then update state).
 */
async function persistOptimistic<T>(
  key: SettingsKey<T>,
  target: Ref<T>,
  value: T,
  apply: (value: T) => void = () => {},
): Promise<void> {
  const previous = target.value
  target.value = value
  apply(value)
  try {
    await getSettingsRepository().set(key, value)
  } catch (e) {
    target.value = previous
    apply(previous)
    throw e
  }
}

function applyDarkClass(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark)
}

const MOBILE_BREAKPOINT = 768

export const useLayoutStore = defineStore('layout', () => {
  const navPosition = ref<NavPosition>('auto')
  const collapseMode = ref<CollapseMode>('opens-on-hover')
  const isDark = ref(false)
  const themePreset = ref<ThemePreset>('Aura')
  const tagRows = ref<TagRowStyle>('detailed')
  const locationsView = ref<LocationsView>('list')
  /** Read-only amounts show a placeholder until tapped (MoneyText). */
  const hideAmounts = ref(false)
  const isTemporarilyToggled = ref(false)

  const navItems = ref([
    { label: 'Home', icon: 'pi pi-home', route: '/' },
    { label: 'Accounts', icon: 'pi pi-wallet', route: '/accounts' },
    { label: 'Tags', icon: 'pi pi-tags', route: '/tags' },
    { label: 'Page Two', icon: 'pi pi-file', route: '/page-two' },
    { label: 'About', icon: 'pi pi-info-circle', route: '/about' },
  ])

  async function hydrate(): Promise<void> {
    await Promise.all([
      hydrateRef(LayoutKeys.navPosition, navPosition, isNavPosition),
      hydrateRef(LayoutKeys.collapseMode, collapseMode, isCollapseMode),
      hydrateRef(LayoutKeys.isDark, isDark, isBoolean),
      hydrateRef(LayoutKeys.themePreset, themePreset, isThemePreset),
      hydrateRef(LayoutKeys.tagRows, tagRows, isTagRowStyle),
      hydrateRef(LayoutKeys.locationsView, locationsView, isLocationsView),
      hydrateRef(LayoutKeys.hideAmounts, hideAmounts, isBoolean),
    ])
  }

  async function setNavPosition(value: NavPosition): Promise<void> {
    await persistOptimistic(LayoutKeys.navPosition, navPosition, value)
  }

  async function setCollapseMode(value: CollapseMode): Promise<void> {
    await persistOptimistic(LayoutKeys.collapseMode, collapseMode, value)
  }

  async function setDarkMode(value: boolean): Promise<void> {
    await persistOptimistic(LayoutKeys.isDark, isDark, value, applyDarkClass)
  }

  async function setThemePreset(value: ThemePreset): Promise<void> {
    await persistOptimistic(LayoutKeys.themePreset, themePreset, value)
  }

  async function setTagRows(value: TagRowStyle): Promise<void> {
    await persistOptimistic(LayoutKeys.tagRows, tagRows, value)
  }

  async function setLocationsView(value: LocationsView): Promise<void> {
    await persistOptimistic(LayoutKeys.locationsView, locationsView, value)
  }

  async function setHideAmounts(value: boolean): Promise<void> {
    await persistOptimistic(LayoutKeys.hideAmounts, hideAmounts, value)
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
    tagRows,
    locationsView,
    hideAmounts,
    isTemporarilyToggled,
    navItems,
    hydrate,
    setNavPosition,
    setCollapseMode,
    setDarkMode,
    setThemePreset,
    setTagRows,
    setLocationsView,
    setHideAmounts,
    effectivePosition,
    isVertical,
  }
})
