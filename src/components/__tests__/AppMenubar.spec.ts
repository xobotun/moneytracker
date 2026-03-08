import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import AppMenubar from '../AppMenubar.vue'

describe('AppMenubar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders the app title', () => {
    const wrapper = mount(AppMenubar, {
      global: {
        plugins: [
          createPinia(),
          [PrimeVue, { theme: { preset: Aura } }],
        ],
        stubs: {
          Menubar: {
            template: '<div><slot name="start" /><slot name="end" /></div>',
            props: ['model'],
          },
          Button: {
            template: '<button><slot /></button>',
            props: ['icon', 'severity', 'text', 'rounded'],
          },
        },
      },
    })
    expect(wrapper.text()).toContain('MoneyTracker')
  })
})
