import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import AppLayout from '../AppLayout.vue'
import { useLayoutStore } from '@/stores/layout'

describe('AppLayout', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  function getMountOptions() {
    return {
      global: {
        plugins: [pinia, [PrimeVue, { theme: { preset: Aura } }]] as [
          Pinia,
          [typeof PrimeVue, { theme: { preset: typeof Aura } }],
        ],
        stubs: {
          AppMenubar: { template: '<div class="stub-menubar" />' },
          AppSidebar: { template: '<div class="stub-sidebar" />' },
          RouterView: { template: '<div class="stub-router-view" />' },
        },
      },
    }
  }

  it('renders menubar for top position', () => {
    const store = useLayoutStore()
    store.navPosition = 'top'
    const wrapper = mount(AppLayout, getMountOptions())
    expect(wrapper.find('.stub-menubar').exists()).toBe(true)
    expect(wrapper.find('.stub-sidebar').exists()).toBe(false)
  })

  it('renders sidebar for left position', () => {
    const store = useLayoutStore()
    store.navPosition = 'left'
    const wrapper = mount(AppLayout, getMountOptions())
    expect(wrapper.find('.stub-sidebar').exists()).toBe(true)
    expect(wrapper.find('.stub-menubar').exists()).toBe(false)
  })

  it('renders content area', () => {
    const store = useLayoutStore()
    store.navPosition = 'top'
    const wrapper = mount(AppLayout, getMountOptions())
    expect(wrapper.find('.stub-router-view').exists()).toBe(true)
  })
})
