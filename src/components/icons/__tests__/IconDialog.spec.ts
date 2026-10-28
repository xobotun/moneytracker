import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { ImagesRepository } from '@/db/repositories/ImagesRepository'
import type { UUID } from '@/db/uuid'
import { primeIcon } from '@/icons/sets'
import { emojiIcon, imageIcon, type Icon } from '@/icons/types'
import { wordSource, wordSvg, type WordSettings } from '@/icons/wordSvg'
import { button, input, pageText, settle, stubBrowser, type } from '@/components/tags/__tests__/dom'
import IconDialog from '../IconDialog.vue'

// Real repository over an in-memory database. The browser-only parts are
// replaced at their module boundary: the emoji library (a button that picks
// 🛒) and the canvas encoder (jsdom has no canvas).
let imagesRepo: ImagesRepository
vi.mock('@/db/init', () => ({ getImagesRepository: () => imagesRepo }))

const { mountEmojiPicker, encodeRaster } = vi.hoisted(() => ({
  mountEmojiPicker: vi.fn(
    (host: HTMLElement, options: { dark: boolean; onPick(emoji: string): void }) => {
      const pick = document.createElement('button')
      pick.type = 'button'
      pick.textContent = '🛒'
      pick.setAttribute('aria-label', 'stub emoji 🛒')
      pick.addEventListener('click', () => options.onPick('🛒'))
      host.append(pick)
      return () => pick.remove()
    },
  ),
  encodeRaster: vi.fn(async (_file: Blob) => ({
    mediaType: 'image/png' as const,
    content: 'iVBORw0KGgoAAAANSUhEUg==',
    side: 64,
  })),
}))
vi.mock('@/icons/emojiPicker', () => ({ mountEmojiPicker }))
vi.mock('@/icons/rasterEncode', () => ({ encodeRaster }))

const RED = '#e30613'
const WORD: WordSettings = {
  text: 'C&A',
  font: 'serif',
  bold: true,
  colour: '#ffffff',
  background: '#1d4ed8',
}

/** An SVG of about `bytes`, padded with paths that survive cleaning. */
function svgOf(bytes: number): string {
  const path = '<path d="M0 0L1 1L2 2L3 3L4 4L5 5L6 6L7 7L8 8L9 9"/>'
  const paths = path.repeat(Math.ceil(bytes / path.length))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${paths}</svg>`
}

/** Waits until `check` passes: lazy chunks load on the first use. */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await settle()
  }
}

describe('IconDialog', () => {
  let db: Database
  let pinia: Pinia
  let wrapper: VueWrapper | null = null
  const icon = ref<Icon>(primeIcon('shop'))
  const visible = ref(false)

  beforeAll(stubBrowser)
  afterAll(() => vi.unstubAllGlobals())

  beforeEach(async () => {
    pinia = createPinia()
    setActivePinia(pinia)
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    imagesRepo = new ImagesRepository(db)
    mountEmojiPicker.mockClear()
    encodeRaster.mockClear()
  })

  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    await db.close()
  })

  async function open(start: Icon) {
    icon.value = start
    visible.value = true
    const Host = defineComponent(
      () => () =>
        h(IconDialog, {
          icon: icon.value,
          'onUpdate:icon': (next: Icon) => (icon.value = next),
          visible: visible.value,
          'onUpdate:visible': (next: boolean) => (visible.value = next),
          colour: RED,
          fallback: primeIcon('shop'),
        }),
    )
    wrapper = mount(Host, {
      attachTo: document.body,
      global: { plugins: [pinia, [PrimeVue, { theme: { preset: Aura } }]] },
    })
    await settle()
  }

  const selectedTab = () =>
    document.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim()

  /** The id of the picture the dialog picked. */
  function pickedImage(): UUID {
    if (icon.value.kind !== 'image') throw new Error(`picked ${JSON.stringify(icon.value)}`)
    return icon.value.image
  }

  async function showTab(name: string) {
    const tab = [...document.querySelectorAll<HTMLElement>('[role=tab]')].find(
      (t) => t.textContent?.trim() === name,
    )!
    tab.click()
    await settle()
  }

  /** The panel a tab shows: the others are hidden. */
  const shownPanel = () =>
    [...document.querySelectorAll<HTMLElement>('[role=tabpanel]')].find(
      (p) => p.style.display !== 'none',
    )!

  async function chooseFile(file: File) {
    const field = document.querySelector<HTMLInputElement>('input[data-image-file]')!
    Object.defineProperty(field, 'files', { value: [file], configurable: true })
    field.dispatchEvent(new Event('change'))
    await settle()
  }

  it('picks a pack icon from the Icons tab, and closes', async () => {
    await open(primeIcon('shop'))
    expect(pageText()).toContain('Choose an icon')
    expect(selectedTab()).toBe('Icons')
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search icons"]')!
    search.value = 'eur'
    search.dispatchEvent(new Event('input'))
    await settle()
    const found = [...document.querySelectorAll('[role=group][aria-label="PrimeIcons"] button')]
    expect(found.map((b) => b.getAttribute('aria-label'))).toEqual(['euro'])
    ;(found[0] as HTMLButtonElement).click()
    await settle()
    expect(icon.value).toEqual(primeIcon('euro'))
    expect(visible.value).toBe(false)
  })

  it('switches tabs', async () => {
    await open(primeIcon('shop'))
    await showTab('Text')
    expect(selectedTab()).toBe('Text')
    expect(shownPanel().contains(input('icon-word-text'))).toBe(true)
    await showTab('Image')
    expect(selectedTab()).toBe('Image')
    expect(shownPanel().textContent).toContain('Choose a file')
    await showTab('Icons')
    expect(shownPanel().querySelector('input[aria-label="Search icons"]')).not.toBeNull()
  })

  it('loads the emoji picker only when its tab opens, and picks an emoji', async () => {
    await open(primeIcon('shop'))
    expect(mountEmojiPicker).not.toHaveBeenCalled()
    await showTab('Emoji')
    await until(() => mountEmojiPicker.mock.calls.length > 0)
    expect(mountEmojiPicker.mock.calls[0]![1].dark).toBe(false)
    button('stub emoji 🛒').click()
    await settle()
    expect(icon.value).toEqual(emojiIcon('🛒'))
    expect(visible.value).toBe(false)
  })

  it('opens an emoji on the Emoji tab', async () => {
    await open(emojiIcon('🍕'))
    expect(selectedTab()).toBe('Emoji')
    await until(() => mountEmojiPicker.mock.calls.length > 0)
  })

  it('saves a word as a picture that keeps its settings', async () => {
    await open(primeIcon('shop'))
    await showTab('Text')
    // A new word starts on the owner's colour, in a readable text colour.
    expect(button('Use this word').disabled).toBe(true)
    await type('icon-word-text', 'C&A')
    button('Serif').click()
    await settle()
    input('icon-word-bold').click() // bold is on for a new word: this turns it off
    await settle()
    button('Use the word C&A as the icon').click()
    await until(() => icon.value.kind === 'image')

    const settings: WordSettings = {
      text: 'C&A',
      font: 'serif',
      bold: false,
      colour: '#ffffff',
      background: RED,
    }
    const image = await imagesRepo.get(pickedImage())
    expect(image).toMatchObject({
      media_type: 'image/svg+xml',
      content: wordSvg(settings),
      width: 256,
      height: 256,
      source: wordSource(settings),
    })
    expect(visible.value).toBe(false)
  })

  it('reopens a word on the Text tab with its settings', async () => {
    const id = await imagesRepo.put({
      mediaType: 'image/svg+xml',
      content: wordSvg(WORD),
      width: 256,
      height: 256,
      source: wordSource(WORD),
    })
    await open(imageIcon(id))
    expect(selectedTab()).toBe('Text')
    expect(input('icon-word-text').value).toBe('C&A')
    expect(button('Serif').getAttribute('aria-pressed')).toBe('true')
    expect(input('icon-word-bold').checked).toBe(true)
    // Its colours, not the owner's.
    expect(shownPanel().querySelector('img')!.getAttribute('src')).toContain(
      encodeURIComponent('#1d4ed8'),
    )
  })

  it('opens an uploaded picture on the Image tab, showing it', async () => {
    const svg = svgOf(100)
    const id = await imagesRepo.put({
      mediaType: 'image/svg+xml',
      content: svg,
      width: 10,
      height: 10,
    })
    await open(imageIcon(id))
    expect(selectedTab()).toBe('Image')
    expect(shownPanel().textContent).toContain('The current picture')
    expect(shownPanel().querySelector('img')!.getAttribute('src')).toContain('svg')
  })

  it('warns about an SVG over 100 KB, and stores it on “Use it anyway”', async () => {
    await open(primeIcon('shop'))
    await showTab('Image')
    await chooseFile(new File([svgOf(150 * 1024)], 'big.svg', { type: 'image/svg+xml' }))
    await until(() => pageText().includes('Every device syncs this picture'))
    expect(() => button('Use this image')).toThrow()
    button('Use it anyway').click()
    await until(() => icon.value.kind === 'image')
    const image = await imagesRepo.get(pickedImage())
    expect(image).toMatchObject({ media_type: 'image/svg+xml', width: 10, height: 10 })
    expect(image!.content.length).toBeGreaterThan(100 * 1024)
  })

  it('refuses an SVG over 1 MB, and a file that is no image', async () => {
    await open(primeIcon('shop'))
    await showTab('Image')
    await chooseFile(new File([svgOf(1024 * 1024 + 10)], 'huge.svg', { type: 'image/svg+xml' }))
    await until(() => document.querySelector('[role=alert]') !== null)
    expect(document.querySelector('[role=alert]')!.textContent).toContain('at most 1.0 MB')

    await chooseFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    await until(() => pageText().includes('This file is not an image.'))
    expect(icon.value).toEqual(primeIcon('shop'))
    expect(await db.exec('SELECT id FROM images')).toEqual([])
  })

  it('stores a raster picture as the browser encoded it', async () => {
    await open(primeIcon('shop'))
    await showTab('Image')
    const photo = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' })
    await chooseFile(photo)
    await until(() => pageText().includes('Use this image'))
    expect(encodeRaster).toHaveBeenCalledWith(photo)
    expect(pageText()).toContain('64 × 64')
    button('Use logo.png as the icon').click()
    await until(() => icon.value.kind === 'image')
    expect(await imagesRepo.get(pickedImage())).toMatchObject({
      media_type: 'image/png',
      content: 'iVBORw0KGgoAAAANSUhEUg==',
      width: 64,
      height: 64,
      source: null,
    })
  })
})
