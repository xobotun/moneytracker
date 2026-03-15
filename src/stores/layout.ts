import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { getSettingsRepository } from '@/db/init'

export type NavPosition = 'auto' | 'top' | 'bottom' | 'left' | 'right'
export type CollapseMode = 'always-collapsed' | 'opens-on-hover' | 'always-expanded'
export type ThemePreset = 'Aura' | 'Material' | 'Lara' | 'Nora'

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
    const repo = getSettingsRepository()
    const storedNavPos = await repo.get<NavPosition>('layout.navPosition')
    if (storedNavPos) navPosition.value = storedNavPos
    const storedCollapse = await repo.get<CollapseMode>('layout.collapseMode')
    if (storedCollapse) collapseMode.value = storedCollapse
    const storedDark = await repo.get<boolean>('layout.isDark')
    if (storedDark !== null) isDark.value = storedDark
    const storedPreset = await repo.get<ThemePreset>('layout.themePreset')
    if (storedPreset) themePreset.value = storedPreset
  }

  async function setNavPosition(value: NavPosition): Promise<void> {
    const repo = getSettingsRepository()
    await repo.set('layout.navPosition', value)
    navPosition.value = value
  }

  async function setCollapseMode(value: CollapseMode): Promise<void> {
    const repo = getSettingsRepository()
    await repo.set('layout.collapseMode', value)
    collapseMode.value = value
  }

  async function setDarkMode(value: boolean): Promise<void> {
    const repo = getSettingsRepository()
    await repo.set('layout.isDark', value)
    isDark.value = value
    document.documentElement.classList.toggle('dark', value)
  }

  async function setThemePreset(value: ThemePreset): Promise<void> {
    const repo = getSettingsRepository()
    await repo.set('layout.themePreset', value)
    themePreset.value = value
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
