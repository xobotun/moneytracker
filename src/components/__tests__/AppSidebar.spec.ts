import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import AppSidebar from '../AppSidebar.vue'
import { useLayoutStore } from '@/stores/layout'

describe('AppSidebar', () => {
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
          Menu: {
            template: '<div class="mock-menu"><slot /></div>',
            props: ['model'],
          },
          Button: {
            template:
              '<button class="mock-button" @click="$emit(\'click\')"><slot /></button>',
            props: ['icon', 'severity', 'text', 'rounded', 'size'],
          },
        },
      },
    }
  }

  it('renders the app title when expanded', () => {
    const store = useLayoutStore()
    store.collapseMode = 'always-expanded'
    const wrapper = mount(AppSidebar, getMountOptions())
    expect(wrapper.text()).toContain('MoneyTracker')
  })

  it('renders short title when collapsed', () => {
    const store = useLayoutStore()
    store.collapseMode = 'always-collapsed'
    const wrapper = mount(AppSidebar, getMountOptions())
    expect(wrapper.text()).toContain('MT')
    expect(wrapper.text()).not.toContain('MoneyTracker')
  })

  it('has a toggle button', () => {
    const wrapper = mount(AppSidebar, getMountOptions())
    expect(wrapper.find('.mock-button').exists()).toBe(true)
  })
})
