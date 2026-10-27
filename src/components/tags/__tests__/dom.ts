import { vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

// Helpers for driving PrimeVue dialogs in jsdom: they render into
// document.body, so the helpers look there rather than in a wrapper.

/** What PrimeVue needs and jsdom lacks: matchMedia (overlays) and ResizeObserver (auto-resize). */
export function stubBrowser(): void {
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
}

/** Waits for SQLite work started by a click (the async build yields to the event loop). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 0))
  }
}

/** The button whose text or `aria-label` is `text`. */
export function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
  )
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

export function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement
}

export async function type(id: string, value: string): Promise<void> {
  const field = input(id)
  field.value = value
  field.dispatchEvent(new Event('input'))
  await settle()
}

/** The option labels of the Select whose input id is `id`, opening it. */
export async function optionsOf(id: string): Promise<HTMLElement[]> {
  ;(input(id).closest('.p-select') as HTMLElement).click()
  await settle()
  return [...document.querySelectorAll<HTMLElement>('.p-select-overlay [role=option]')]
}

/** Picks `label` in the Select whose input id is `id`. */
export async function choose(id: string, label: string): Promise<void> {
  const option = (await optionsOf(id)).find((o) => o.textContent?.trim() === label)
  if (!option) throw new Error(`no option "${label}"`)
  // Select picks an option on mousedown.
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await settle()
}

/** The page's text with runs of whitespace collapsed, as a browser shows it. */
export const pageText = (): string => (document.body.textContent ?? '').replace(/\s+/g, ' ')
