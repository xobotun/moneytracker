import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { settle, stubBrowser } from '@/components/tags/__tests__/dom'
import { primeIcon } from '@/icons/sets'
import { asShortId } from '@/db/shortId'
import type { TagLook } from '@/tags/look'
import type { TagSuggestion } from '@/tags/tree'
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

  async function mountWith(start: string[], extra: Record<string, unknown> = {}) {
    chips.value = start
    const Host = defineComponent({
      setup: () => () =>
        h(ChipsInput, {
          ref: field,
          modelValue: chips.value,
          'onUpdate:modelValue': (next: string[]) => (chips.value = next),
          inputId: 'names',
          ...extra,
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

  describe('with suggestions', () => {
    const look: TagLook = {
      icon: primeIcon('heart'),
      colour: '#ef4444',
      fallback: primeIcon('hashtag'),
    }
    const TAGS: TagSuggestion[] = [
      { id: asShortId('family'), name: 'family', label: 'family', ...look },
      { id: asShortId('mia'), name: 'mia', label: 'family › mia', ...look },
    ]
    const picks: TagSuggestion[] = []
    const suggest = (query: string) => TAGS.filter((t) => t.label.includes(query))
    const withSuggestions = (start: string[]) =>
      mountWith(start, { suggest, onPick: (s: TagSuggestion) => picks.push(s) })

    async function typeAndWait(text: string) {
      await typeText(text)
      // AutoComplete waits 300 ms after typing before it searches.
      await new Promise((r) => setTimeout(r, 400))
      await settle()
    }
    const options = () => [
      ...document.querySelectorAll<HTMLElement>('.p-autocomplete-overlay [role=option]'),
    ]
    const enter = () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      })
      input().dispatchEvent(event)
      return event
    }

    it('offers what the typed text finds, by label with an icon, and adds the main name of the one picked', async () => {
      picks.length = 0
      await withSuggestions([])
      await typeAndWait('mi')
      expect(options().map((o) => o.textContent?.trim())).toEqual(['family', 'family › mia'])
      expect(options()[1]!.querySelector('.pi-heart')).not.toBeNull()

      options()[1]!.click()
      await settle()
      expect(chips.value).toEqual(['mia'])
      expect(picks.map((p) => p.id)).toEqual(['mia'])
      expect(input().value).toBe('')
    })

    it('keeps the focus in the field when a suggestion is pressed', async () => {
      await withSuggestions([])
      await typeAndWait('mi')
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      options()[0]!.dispatchEvent(press)
      expect(press.defaultPrevented).toBe(true)
    })

    it('adds the typed text on Enter when no suggestion is highlighted, without submitting', async () => {
      await withSuggestions(['family'])
      await typeAndWait('  milk ')
      const event = enter()
      await settle()
      expect(event.defaultPrevented).toBe(true)
      expect(chips.value).toEqual(['family', 'milk'])
      expect(input().value).toBe('')
    })

    it('picks the highlighted suggestion on Enter instead', async () => {
      await withSuggestions([])
      await typeAndWait('mi')
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }),
      )
      await settle()
      enter()
      await settle()
      expect(chips.value).toEqual(['family']) // not 'mi'
    })

    it('offers nothing once the typed text has become a chip', async () => {
      await withSuggestions([])
      await typeText('mi')
      enter() // before the search runs
      await new Promise((r) => setTimeout(r, 400))
      await settle()
      expect(chips.value).toEqual(['mi'])
      expect(options()).toEqual([])
    })

    it('draws a chip with a look with its icon, and one without plain', async () => {
      const chipLook = (chip: string) => (chip === 'mia' ? look : null)
      await mountWith(['mia', 'brand new'], { suggest, chipLook })
      const items = [...document.querySelectorAll('.p-autocomplete-chip-item')]
      expect(items.map((c) => c.textContent?.trim())).toEqual(['mia', 'brand new'])
      expect(items[0]!.querySelector('[data-chip-icon].pi-heart')).not.toBeNull()
      expect(items[1]!.querySelector('[data-chip-icon]')).toBeNull()
    })
  })
})
