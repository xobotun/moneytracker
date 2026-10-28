import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { moneyAmount } from '@/db/MoneyAmount'
import { formatApprox, formatMoney } from '@/format/currency'
import { useLayoutStore } from '@/stores/layout'
import type { BalanceView } from '@/money/totals'
import MoneyText from '../MoneyText.vue'
import BalanceDisplay from '../accounts/BalanceDisplay.vue'

const HIDDEN = 'button[aria-label="Amount hidden, show it"]'

describe('MoneyText', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  function mountWith<P extends object>(component: object, props: P) {
    wrapper = mount(component, {
      props,
      global: { plugins: [pinia, [PrimeVue, { theme: { preset: Aura } }]] },
    })
    return wrapper
  }

  it('shows an exact amount in full and a converted one rounded, after its prefix', () => {
    const exact = moneyAmount(-123456, 3, 'EUR')
    expect(mountWith(MoneyText, { amount: exact }).text()).toBe(formatMoney(exact))
    wrapper!.unmount()
    const converted = { value: 12.3456, currency: 'USD' }
    expect(mountWith(MoneyText, { amount: converted, prefix: '≈' }).text()).toBe(
      `≈ ${formatApprox(converted)}`,
    )
  })

  it('is red when negative only if asked to', () => {
    const negative = moneyAmount(-500, 2, 'EUR')
    expect(mountWith(MoneyText, { amount: negative }).classes()).not.toContain('text-red-600')
    wrapper!.unmount()
    expect(mountWith(MoneyText, { amount: negative, signed: true }).classes()).toContain(
      'text-red-600',
    )
  })

  describe('with amounts hidden', () => {
    beforeEach(() => {
      useLayoutStore(pinia).hideAmounts = true
    })

    it('renders a placeholder button and nothing of the value, not even its sign', () => {
      const amount = moneyAmount(-123456, 2, 'EUR')
      const w = mountWith(MoneyText, { amount, prefix: '≈', signed: true })
      const html = w.html()
      expect(html).not.toContain(formatMoney(amount))
      expect(html).not.toMatch(/1,?234/)
      expect(html).not.toContain('€')
      expect(html).not.toContain('text-red')
      expect(w.text()).toBe('≈ •••')
      expect(w.find(HIDDEN).exists()).toBe(true)
      expect(w.find(HIDDEN).attributes('type')).toBe('button') // never submits a form around it
    })

    it('shows the amount once the placeholder is pressed', async () => {
      const amount = moneyAmount(1250, 2, 'EUR')
      const w = mountWith(MoneyText, { amount })
      await w.find(HIDDEN).trigger('click')
      expect(w.text()).toBe(formatMoney(amount))
      expect(w.find(HIDDEN).exists()).toBe(false)
    })

    it('shows a balance and its ≈ base amount together', async () => {
      const view: BalanceView = {
        native: moneyAmount(1000, 2, 'USD'),
        base: { value: 5, currency: 'EUR' },
        relation: '≈',
        missingRates: [],
      }
      const w = mountWith(BalanceDisplay, { view, baseCurrency: 'EUR' })
      expect(w.findAll(HIDDEN)).toHaveLength(2)
      expect(w.html()).not.toContain(formatMoney(view.native!))

      await w.findAll(HIDDEN)[1]!.trigger('click')

      expect(w.findAll(HIDDEN)).toHaveLength(0)
      expect(w.text()).toContain(formatMoney(view.native!))
      expect(w.text()).toContain(`≈ ${formatApprox(view.base!)}`)
    })

    it('keeps the note about a missing rate, which holds no amount', () => {
      const view: BalanceView = {
        native: moneyAmount(1000, 2, 'AED'),
        base: null,
        relation: '≈',
        missingRates: ['AED'],
      }
      const w = mountWith(BalanceDisplay, { view, baseCurrency: 'EUR' })
      expect(w.text()).toContain('no AED → EUR rate')
      expect(w.findAll(HIDDEN)).toHaveLength(1)
    })
  })
})
