import Picker from 'emoji-picker-element/picker'
// The emoji data ships with the app (the service worker precaches it), so the
// picker works offline; the library's default would fetch it from a CDN.
import dataSource from 'emoji-picker-element-data/en/emojibase/data.json?url'

// The full emoji picker of the icon dialog's Emoji tab
// (docs/plans/2026-10-28-icons-design.md §5): emoji-picker-element, a small
// web component with search, skin tones and recently used emoji. This module
// is imported only when the tab first opens, so neither the library nor its
// data weighs on the app's start.

export interface EmojiPickerOptions {
  /** The app's theme: the picker would otherwise follow the system's. */
  dark: boolean
  /** Called with the emoji picked (with its skin tone, if one was chosen). */
  onPick(emoji: string): void
}

/** The width an emoji takes in the grid: 1.375rem plus 0.5rem padding on each side. */
const EMOJI_CELL_PX = 38

/** The picker in the app's colours (PrimeVue's tokens), on the dialog's background. */
const THEME: Record<string, string> = {
  '--background': 'var(--p-overlay-modal-background)',
  '--border-color': 'var(--p-content-border-color)',
  '--border-size': '0',
  '--indicator-color': 'var(--p-primary-color)',
  '--input-border-color': 'var(--p-form-field-border-color)',
  '--input-font-color': 'var(--p-form-field-color)',
  '--input-placeholder-color': 'var(--p-form-field-placeholder-color)',
  '--input-border-radius': '6px',
  '--input-padding': '0.375rem 0.625rem',
  '--outline-color': 'var(--p-primary-color)',
  '--category-font-color': 'var(--p-text-muted-color)',
  '--category-font-size': '0.875rem',
  '--button-hover-background': 'var(--p-content-hover-background)',
  '--button-active-background': 'var(--p-highlight-background)',
}

/** Puts a picker into `host`; returns a function that removes it. */
export function mountEmojiPicker(host: HTMLElement, options: EmojiPickerOptions): () => void {
  const picker = new Picker({ dataSource, locale: 'en' })
  picker.classList.add(options.dark ? 'dark' : 'light')
  for (const [name, value] of Object.entries(THEME)) picker.style.setProperty(name, value)
  const columns = Math.max(6, Math.floor(host.clientWidth / EMOJI_CELL_PX))
  picker.style.setProperty('--num-columns', String(columns))
  picker.style.width = '100%'
  picker.style.height = '100%'
  picker.addEventListener('emoji-click', (event) => {
    const emoji = event.detail.unicode
    if (emoji) options.onPick(emoji)
  })
  host.append(picker)
  return () => picker.remove()
}
