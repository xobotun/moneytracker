import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import HomeView from '../../views/HomeView.vue'

describe('HomeView', () => {
  it('renders welcome message', () => {
    const wrapper = mount(HomeView, {
      global: {
        plugins: [[PrimeVue, { theme: { preset: Aura } }]],
      },
    })

    expect(wrapper.text()).toContain('Welcome to Money Tracker')
  })
})
