import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMoneySettingsStore } from '../moneySettings'

const stored = new Map<string, unknown>()
const writeMode = { value: 'ok' as 'ok' | 'fail' }
vi.mock('@/db/init', () => ({
  getSettingsRepository: () => ({
    get: async (key: { key: string }) => stored.get(key.key) ?? null,
    set: async (key: { key: string }, value: unknown) => {
      if (writeMode.value === 'fail') throw new Error('disk full')
      stored.set(key.key, value)
    },
  }),
}))

describe('useMoneySettingsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stored.clear()
    writeMode.value = 'ok'
  })

  it('defaults the base currency to EUR', async () => {
    const store = useMoneySettingsStore()
    await store.hydrate()
    expect(store.baseCurrency).toBe('EUR')
  })

  it('hydrates a stored base currency', async () => {
    stored.set('money.baseCurrency', 'USD')
    const store = useMoneySettingsStore()
    await store.hydrate()
    expect(store.baseCurrency).toBe('USD')
  })

  it('keeps the default when the stored value is not a currency code', async () => {
    stored.set('money.baseCurrency', 'U S D')
    const store = useMoneySettingsStore()
    await store.hydrate()
    expect(store.baseCurrency).toBe('EUR')
  })

  it('setBaseCurrency() stores the normalised code, then shows it', async () => {
    const store = useMoneySettingsStore()
    await store.setBaseCurrency(' rub ')
    expect(store.baseCurrency).toBe('RUB')
    expect(stored.get('money.baseCurrency')).toBe('RUB')
  })

  it('setBaseCurrency() rejects an invalid code without storing it', async () => {
    const store = useMoneySettingsStore()
    await expect(store.setBaseCurrency('  ')).rejects.toThrow('Enter a currency code')
    expect(store.baseCurrency).toBe('EUR')
    expect(stored.has('money.baseCurrency')).toBe(false)
  })

  it('setBaseCurrency() keeps the old value when saving fails', async () => {
    writeMode.value = 'fail'
    const store = useMoneySettingsStore()
    await expect(store.setBaseCurrency('USD')).rejects.toThrow('disk full')
    expect(store.baseCurrency).toBe('EUR')
  })
})
