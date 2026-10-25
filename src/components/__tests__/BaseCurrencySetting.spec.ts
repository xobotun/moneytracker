import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import BaseCurrencySetting from '../BaseCurrencySetting.vue'
import { useMoneySettingsStore } from '@/stores/moneySettings'

const stored = new Map<string, unknown>()
// Every value written, in order: shows a half-typed value was never saved.
const writes: unknown[] = []
vi.mock('@/db/init', () => ({
  getSettingsRepository: () => ({
    get: async (key: { key: string }) => stored.get(key.key) ?? null,
    set: async (key: { key: string }, value: unknown) => {
      stored.set(key.key, value)
      writes.push(value)
    },
  }),
}))

describe('BaseCurrencySetting', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeAll(() => {
    // PrimeVue overlays query matchMedia; jsdom has none.
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
    stored.clear()
    writes.length = 0
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  async function mountSetting() {
    await useMoneySettingsStore().hydrate()
    wrapper = mount(BaseCurrencySetting, {
      attachTo: document.body,
      global: { plugins: [pinia, [PrimeVue, { theme: { preset: Aura } }]] },
    })
    await flushPromises()
    return wrapper
  }

  const input = () => document.getElementById('base-currency') as HTMLInputElement

  async function type(value: string) {
    input().value = value
    input().dispatchEvent(new Event('input'))
    await flushPromises()
  }

  const blur = () => input().dispatchEvent(new FocusEvent('blur'))

  async function openSuggestions(query: string) {
    await type(query)
    // AutoComplete waits 300 ms after typing before it searches.
    await new Promise((r) => setTimeout(r, 400))
    await flushPromises()
  }

  const option = (code: string) =>
    [...document.querySelectorAll<HTMLElement>('.p-autocomplete-overlay [role=option]')].find(
      (o) => o.getAttribute('aria-label') === code,
    )!

  it('shows EUR by default, with no Save button', async () => {
    const w = await mountSetting()
    expect(input().value).toBe('EUR')
    expect(w.find('button[aria-label="Save"], button.p-button').exists()).toBe(false)
  })

  it('saves a picked suggestion at once', async () => {
    await mountSetting()
    await openSuggestions('rub')
    option('RUB').click()
    await flushPromises()
    expect(useMoneySettingsStore().baseCurrency).toBe('RUB')
    expect(writes).toEqual(['RUB'])
  })

  it('saves a typed code when the field loses focus', async () => {
    await mountSetting()
    await type('btc')
    expect(writes).toEqual([]) // typing alone saves nothing
    blur()
    await flushPromises()
    expect(writes).toEqual(['BTC'])
    expect(input().value).toBe('BTC')
  })

  it('never saves the half-typed value when a suggestion is clicked', async () => {
    await mountSetting()
    await openSuggestions('ru')
    // Pressing on a suggestion blurs the field first, while the list is open.
    blur()
    await flushPromises()
    option('RUB').click()
    await new Promise((r) => setTimeout(r, 300)) // the list's closing transition
    await flushPromises()
    expect(writes).toEqual(['RUB'])
  })

  it('refuses a code with spaces on blur and says why', async () => {
    const w = await mountSetting()
    await type('b t c')
    blur()
    await flushPromises()
    expect(w.text()).toContain('A currency code has no spaces.')
    expect(writes).toEqual([])
  })
})
