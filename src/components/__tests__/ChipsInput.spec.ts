import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { settle, stubBrowser } from '@/components/tags/__tests__/dom'
import ChipsInput from '../ChipsInput.vue'

describe('ChipsInput', () => {
  let wrapper: VueWrapper | null = null
  const chips = ref<string[]>([])
  const field = ref<InstanceType<typeof ChipsInput> | null>(null)

  beforeAll(stubBrowser)
  afterAll(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  async function mountWith(start: string[]) {
    chips.value = start
    const Host = defineComponent({
      setup: () => () =>
        h(ChipsInput, {
          ref: field,
          modelValue: chips.value,
          'onUpdate:modelValue': (next: string[]) => (chips.value = next),
          inputId: 'names',
        }),
    })
    wrapper = mount(Host, {
      attachTo: document.body,
      global: { plugins: [[PrimeVue, { theme: { preset: Aura } }]] },
    })
    await settle()
  }

  const input = () => document.getElementById('names') as HTMLInputElement
  async function typeText(text: string) {
    input().value = text
    input().dispatchEvent(new Event('input'))
    await settle()
  }
  const shown = () =>
    [...document.querySelectorAll('.p-autocomplete-chip-item')].map((c) => c.textContent?.trim())

  it('turns text left typed into a chip when the field loses focus', async () => {
    await mountWith(['Billa'])
    await typeText('  REWE Markt ')
    input().dispatchEvent(new Event('blur'))
    await settle()
    expect(chips.value).toEqual(['Billa', 'REWE Markt'])
    expect(shown()).toEqual(['Billa', 'REWE Markt'])
    expect(input().value).toBe('')
  })

  it('adds no empty chip, and none the list has, ignoring case', async () => {
    await mountWith(['Billa'])
    await typeText('   ')
    input().dispatchEvent(new Event('blur'))
    await typeText('BILLA')
    input().dispatchEvent(new Event('blur'))
    await settle()
    expect(chips.value).toEqual(['Billa'])
    expect(input().value).toBe('')
  })

  it('commits on demand', async () => {
    await mountWith([])
    await typeText('Edeka')
    field.value!.commit()
    await settle()
    expect(chips.value).toEqual(['Edeka'])
    field.value!.commit() // nothing left typed: no change
    expect(chips.value).toEqual(['Edeka'])
  })
})
