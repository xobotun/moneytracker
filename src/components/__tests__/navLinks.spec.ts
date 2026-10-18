import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import AppSidebar from '../AppSidebar.vue'
import AppMenubar from '../AppMenubar.vue'
import { useLayoutStore } from '@/stores/layout'

// Real PrimeVue components + a real router (no stubs): these tests check the
// rendered links and accessible names the user actually gets.

const Empty = { template: '<div />' }

async function makeRouter(path: string): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/', '/page-two', '/about', '/settings'].map((p) => ({ path: p, component: Empty })),
  })
  await router.push(path)
  await router.isReady()
  return router
}

function mountWith(component: object, pinia: Pinia, router: Router) {
  return mount(component, {
    global: { plugins: [pinia, router, [PrimeVue, { theme: { preset: Aura } }]] },
  })
}

describe('navigation links and accessible names', () => {
  let pinia: Pinia

  beforeAll(() => {
    // PrimeVue's Menubar queries matchMedia for its mobile breakpoint; jsdom has none.
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  describe('AppSidebar', () => {
    it('renders nav items as real links and marks the current page', async () => {
      useLayoutStore().collapseMode = 'always-expanded'
      const wrapper = mountWith(AppSidebar, pinia, await makeRouter('/about'))

      expect(wrapper.find('a[href="/"]').exists()).toBe(true)
      expect(wrapper.find('a[href="/about"]').attributes('aria-current')).toBe('page')
      expect(wrapper.find('a[href="/"]').attributes('aria-current')).toBeUndefined()
    })

    it('links to Settings', async () => {
      const wrapper = mountWith(AppSidebar, pinia, await makeRouter('/'))
      expect(wrapper.find('a[href="/settings"]').exists()).toBe(true)
    })

    it('gives the collapsed, icon-only controls accessible names', async () => {
      useLayoutStore().collapseMode = 'always-collapsed'
      const wrapper = mountWith(AppSidebar, pinia, await makeRouter('/'))

      expect(wrapper.find('nav').attributes('aria-label')).toBeTruthy()
      expect(wrapper.find('a[href="/"]').attributes('aria-label')).toBe('Home')
      expect(wrapper.find('a[href="/settings"]').attributes('aria-label')).toBe('Settings')
      const toggle = wrapper.findAll('button').find((b) => b.attributes('aria-label')?.includes('sidebar'))
      expect(toggle?.attributes('aria-label')).toBe('Expand sidebar')
    })
  })

  describe('AppMenubar', () => {
    it('renders nav items as real links and marks the current page', async () => {
      const wrapper = mountWith(AppMenubar, pinia, await makeRouter('/page-two'))

      expect(wrapper.find('a[href="/page-two"]').attributes('aria-current')).toBe('page')
      expect(wrapper.find('a[href="/about"]').attributes('aria-current')).toBeUndefined()
    })

    it('links to Settings with an accessible name', async () => {
      const wrapper = mountWith(AppMenubar, pinia, await makeRouter('/'))
      expect(wrapper.find('a[href="/settings"]').attributes('aria-label')).toBe('Settings')
    })
  })
})
