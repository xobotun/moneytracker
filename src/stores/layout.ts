import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

export type NavPosition = 'auto' | 'top' | 'bottom' | 'left' | 'right'
export type CollapseMode = 'always-collapsed' | 'opens-on-hover' | 'always-expanded'

const MOBILE_BREAKPOINT = 768

export const useLayoutStore = defineStore('layout', () => {
  const navPosition = ref<NavPosition>('auto')
  const collapseMode = ref<CollapseMode>('opens-on-hover')
  const isTemporarilyToggled = ref(false)

  const navItems = ref([
    { label: 'Home', icon: 'pi pi-home', route: '/' },
    { label: 'Page Two', icon: 'pi pi-file', route: '/page-two' },
    { label: 'About', icon: 'pi pi-info-circle', route: '/about' },
  ])

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
    isTemporarilyToggled,
    navItems,
    effectivePosition,
    isVertical,
  }
})
