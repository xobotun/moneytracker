import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import BaseCurrencySetting from '../BaseCurrencySetting.vue'
import { useMoneySettingsStore } from '@/stores/moneySettings'

const stored = new Map<string, unknown>()
vi.mock('@/db/init', () => ({
  getSettingsRepository: () => ({
    get: async (key: { key: string }) => stored.get(key.key) ?? null,
    set: async (key: { key: string }, value: unknown) => {
      stored.set(key.key, value)
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

  const saveButton = (w: VueWrapper) => w.findAll('button').find((b) => b.text() === 'Save')

  it('shows EUR by default, with nothing to save', async () => {
    const w = await mountSetting()
    expect(input().value).toBe('EUR')
    expect(saveButton(w)).toBeUndefined()
  })

  it('saves a picked suggestion at once', async () => {
    await mountSetting()
    await type('rub')
    // AutoComplete waits 300 ms after typing before it searches.
    await new Promise((r) => setTimeout(r, 400))
    await flushPromises()
    const option = [
      ...document.querySelectorAll<HTMLElement>('.p-autocomplete-overlay [role=option]'),
    ].find((o) => o.textContent?.includes('RUB'))!
    option.click()
    await flushPromises()
    expect(useMoneySettingsStore().baseCurrency).toBe('RUB')
    expect(stored.get('money.baseCurrency')).toBe('RUB')
  })

  it('saves a typed custom code with Save', async () => {
    const w = await mountSetting()
    await type('btc')
    expect(stored.has('money.baseCurrency')).toBe(false) // typing alone saves nothing
    await saveButton(w)!.trigger('click')
    await flushPromises()
    expect(stored.get('money.baseCurrency')).toBe('BTC')
    expect(input().value).toBe('BTC')
    expect(saveButton(w)).toBeUndefined()
  })

  it('refuses a code with spaces and says why', async () => {
    const w = await mountSetting()
    await type('b t c')
    await saveButton(w)!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('A currency code has no spaces.')
    expect(stored.has('money.baseCurrency')).toBe(false)
  })
})
