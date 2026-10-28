import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { TagsRepository } from '@/db/repositories/TagsRepository'
import { TagDetailsRepository } from '@/db/repositories/TagDetailsRepository'
import type { Tag, TagKind } from '@/db/types'
import type { ShortId } from '@/db/shortId'
import { DERIVED_CLASS } from '@/components/derived'
import { formatDay } from '@/format/date'
import { todayLocal } from '@/money/dates'
import { useTagsStore } from '@/stores/tags'
import TagEditDialog from '../TagEditDialog.vue'
import { button, choose, input, optionsOf, pageText, settle, stubBrowser, type } from './dom'
import { addAccount, spend } from './records'

// Real store and repositories over an in-memory database; only the
// module-level repository registry is replaced.
let tagsRepo: TagsRepository
let detailsRepo: TagDetailsRepository
vi.mock('@/db/init', () => ({
  getTagsRepository: () => tagsRepo,
  getTagDetailsRepository: () => detailsRepo,
}))

// Leaflet does not run in jsdom: the map is a button that picks Munich, and
// shows where it was asked to open.
const MapStub = defineComponent({
  props: { latitude: Number, longitude: Number, radius: Number, fallback: Object },
  emits: ['pick'],
  setup(props, { emit }) {
    return () =>
      h(
        'button',
        {
          type: 'button',
          'data-fallback': JSON.stringify(props.fallback ?? null),
          onClick: () => emit('pick', 48.137154, 11.576124),
        },
        'Pick on the map',
      )
  },
})

describe('TagEditDialog', () => {
  let db: Database
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeAll(stubBrowser)

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(async () => {
    pinia = createPinia()
    setActivePinia(pinia)
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    tagsRepo = new TagsRepository(db)
    detailsRepo = new TagDetailsRepository(db)
  })

  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    await db.close()
  })

  async function open(kind: TagKind, tag: Tag | null, parentId: ShortId | null = null) {
    await useTagsStore().load()
    wrapper = mount(TagEditDialog, {
      attachTo: document.body,
      props: { kind, tag, parentId, visible: true },
      global: {
        plugins: [pinia, [PrimeVue, { theme: { preset: Aura } }]],
        stubs: { LocationMap: MapStub },
      },
    })
    await settle()
    return wrapper
  }

  async function save(label = 'Save') {
    button(label).click()
    await settle()
  }

  const text = pageText

  it('creates a top-level category with a preset colour and the kind icon', async () => {
    const w = await open('category', null)
    expect(text()).toContain('New category')
    await type('tag-name', 'Food')
    await save('Add category')
    const food = await tagsRepo.findByName('category', 'Food', null)
    expect(food).toMatchObject({ icon: primeIcon('tag') })
    expect(food!.colour).not.toBeNull()
    expect(w.emitted('update:visible')).toEqual([[false]])
  })

  it('asks for a name before saving', async () => {
    await open('category', null)
    await save('Add category')
    expect(text()).toContain('Give the tag a name.')
    expect(await tagsRepo.list()).toEqual([])
  })

  it('creates a child that inherits its look', async () => {
    const food = await tagsRepo.create({
      kind: 'category',
      name: 'Food',
      colour: '#ef4444',
      icon: primeIcon('tag'),
    })
    await open('category', null, food.id)
    expect(text()).toContain('Inherited: from Food')
    await type('tag-name', 'Groceries')
    await save('Add category')
    expect(await tagsRepo.findByName('category', 'Groceries', food.id)).toMatchObject({
      colour: null,
      icon: null,
    })
  })

  it('renames and moves in one save', async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    const fun = await tagsRepo.create({ kind: 'category', name: 'Fun' })
    const snacks = await tagsRepo.create({ kind: 'category', name: 'Snacks', parent_id: food.id })
    await open('category', snacks)
    await type('tag-name', 'Treats')
    await choose('tag-parent', 'Fun')
    await save()
    expect(await tagsRepo.findById(snacks.id)).toMatchObject({ name: 'Treats', parent_id: fun.id })
  })

  it('moves a child back to the top level', async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    const snacks = await tagsRepo.create({ kind: 'category', name: 'Snacks', parent_id: food.id })
    await open('category', snacks)
    await choose('tag-parent', 'None (top level)')
    await save()
    expect(await tagsRepo.findById(snacks.id)).toMatchObject({ parent_id: null })
  })

  /** Holds back the next details read until `release()` is called. */
  function slowDetails() {
    const read = detailsRepo.values.bind(detailsRepo)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(detailsRepo, 'values').mockImplementationOnce(async (id, kind) => {
      await gate
      return read(id, kind)
    })
    return () => release()
  }

  it('keeps what was typed while the details load', async () => {
    const shop = await tagsRepo.create({ kind: 'location', name: 'Shop' })
    await detailsRepo.setLocation(shop.id, {
      address: 'Weg 1',
      latitude: null,
      longitude: null,
      merchant_id: null,
    })
    const release = slowDetails()
    await open('location', shop)
    await type('tag-name', 'Rewe')
    release()
    await settle()
    expect(input('tag-name').value).toBe('Rewe')
    expect(input('tag-address').value).toBe('Weg 1')
  })

  it('ignores details that arrive after the dialog moved on', async () => {
    const shop = await tagsRepo.create({ kind: 'location', name: 'Shop' })
    await detailsRepo.setLocation(shop.id, {
      address: 'Weg 1',
      latitude: null,
      longitude: null,
      merchant_id: null,
    })
    const release = slowDetails()
    const w = await open('location', shop)
    await w.setProps({ visible: false })
    await w.setProps({ tag: null, visible: true })
    await settle()
    release()
    await settle()
    expect(text()).toContain('New location')
    expect(input('tag-address').value).toBe('')
  })

  it('keeps Save disabled when the details could not be read', async () => {
    const shop = await tagsRepo.create({ kind: 'location', name: 'Shop' })
    await detailsRepo.setLocation(shop.id, {
      address: 'Weg 1',
      latitude: 52.5,
      longitude: 13.4,
      merchant_id: null,
    })
    vi.spyOn(detailsRepo, 'values').mockRejectedValue(new Error('disk on fire'))
    await open('location', shop)
    expect(text()).toContain("Could not load the location's details. disk on fire")
    expect(button('Save').disabled).toBe(true)
    // Saving the empty details would have wiped the stored ones.
    expect(await detailsRepo.getLocation(shop.id)).toMatchObject({
      address: 'Weg 1',
      latitude: 52.5,
    })
  })

  it('does not offer the tag itself or its descendants as a parent', async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    await tagsRepo.create({ kind: 'category', name: 'Groceries', parent_id: food.id })
    await tagsRepo.create({ kind: 'category', name: 'Fun' })
    await open('category', food)
    const options = (await optionsOf('tag-parent')).map((o) => o.textContent?.trim())
    expect(options).toEqual(['None (top level)', 'Fun'])
  })

  it('shows the inherited colour as derived and resets an own one', async () => {
    const food = await tagsRepo.create({
      kind: 'category',
      name: 'Food',
      colour: '#ef4444',
      icon: primeIcon('tag'),
    })
    const snacks = await tagsRepo.create({
      kind: 'category',
      name: 'Snacks',
      parent_id: food.id,
      colour: '#3b82f6',
    })
    await open('category', snacks)
    const inherited = () => [...document.querySelectorAll('[title="Inherited: from Food"]')]
    expect(inherited()).toHaveLength(1) // only the icon so far
    button('Use the colour from Food').click()
    await settle()
    // Now the colour too, before the icon in the dialog.
    expect(inherited()).toHaveLength(2)
    expect(inherited()[0]!.querySelector('[aria-label="Custom colour"]')).not.toBeNull()
    for (const picker of inherited()) expect(picker.className).toContain(DERIVED_CLASS)
    await save()
    expect(await tagsRepo.findById(snacks.id)).toMatchObject({ colour: null })
  })

  it("edits a location's address, position and merchant", async () => {
    const rewe = await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
    const shop = await tagsRepo.create({ kind: 'location', name: 'Shop' })
    const getCurrentPosition = vi.fn((ok: PositionCallback) =>
      ok({ coords: { latitude: 52.5200081, longitude: 13.4049541 } } as GeolocationPosition),
    )
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } })
    try {
      await open('location', shop)
      await type('tag-address', 'Alexanderplatz 1')
      button('Use my position').click()
      await settle()
      await choose('tag-merchant', 'Rewe')
      await save()
    } finally {
      vi.stubGlobal('navigator', navigator)
    }
    expect(await detailsRepo.getLocation(shop.id)).toEqual({
      tag_id: shop.id,
      address: 'Alexanderplatz 1',
      latitude: 52.520008,
      longitude: 13.404954,
      merchant_id: rewe.id,
      radius_metres: 10,
      auto_match: true,
    })
  })

  it('picks the position on the map', async () => {
    const shop = await tagsRepo.create({ kind: 'location', name: 'Shop' })
    await open('location', shop)
    button('Pick on the map').click()
    await settle()
    await save()
    expect(await detailsRepo.getLocation(shop.id)).toMatchObject({
      latitude: 48.137154,
      longitude: 11.576124,
    })
  })

  it('opens the map on the nearest ancestor with a position', async () => {
    const berlin = await tagsRepo.create({ kind: 'location', name: 'Berlin' })
    await detailsRepo.setLocation(berlin.id, {
      address: null,
      latitude: 52.52,
      longitude: 13.405,
      merchant_id: null,
    })
    const mitte = await tagsRepo.create({ kind: 'location', name: 'Mitte', parent_id: berlin.id })
    await open('location', null, mitte.id)
    expect(button('Pick on the map').dataset.fallback).toBe(
      JSON.stringify({ latitude: 52.52, longitude: 13.405 }),
    )
  })

  it('turns automatic matching off for a location', async () => {
    const market = await tagsRepo.create({ kind: 'location', name: 'Market' })
    await open('location', market)
    expect(input('tag-auto-match').checked).toBe(true)
    input('tag-auto-match').click()
    await settle()
    await save()
    expect((await detailsRepo.getLocation(market.id))!.auto_match).toBe(false)
  })

  it('turns automatic matching off for a merchant', async () => {
    const shop = await tagsRepo.create({ kind: 'merchant', name: 'Shop' })
    await open('merchant', shop)
    expect(input('tag-auto-match').checked).toBe(true)
    input('tag-auto-match').click()
    await settle()
    await save()
    expect((await detailsRepo.getMerchant(shop.id))!.auto_match).toBe(false)
  })

  it("edits a location's radius; empty is the default", async () => {
    const shop = await tagsRepo.create({ kind: 'location', name: 'Shop' })
    await open('location', shop)
    expect(input('tag-radius').value).toBe('10 m')
    // InputNumber takes a typed value when it loses focus.
    input('tag-radius').value = '80'
    input('tag-radius').dispatchEvent(new Event('blur'))
    await settle()
    await save()
    expect((await detailsRepo.getLocation(shop.id))!.radius_metres).toBe(80)
  })

  it('shows why the device gave no position', async () => {
    const shop = await tagsRepo.create({ kind: 'location', name: 'Shop' })
    const getCurrentPosition = vi.fn((_ok: PositionCallback, fail: PositionErrorCallback) =>
      fail({ message: 'User denied Geolocation' } as GeolocationPositionError),
    )
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } })
    try {
      await open('location', shop)
      button('Use my position').click()
      await settle()
    } finally {
      vi.stubGlobal('navigator', navigator)
    }
    expect(text()).toContain('Could not get the position. User denied Geolocation')
  })

  it("shows each default category's icon in its colour, in the list and once picked", async () => {
    await tagsRepo.create({
      kind: 'category',
      name: 'Food',
      colour: '#ef4444',
      icon: primeIcon('gift'),
    })
    const shop = await tagsRepo.create({ kind: 'merchant', name: 'Shop' })
    await open('merchant', shop)
    const options = await optionsOf('tag-default-category')
    const option = (label: string) => options.find((o) => o.textContent?.trim() === label)!
    const icon = option('Food').querySelector<HTMLElement>('.pi-gift')!
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.style.color).toBe('rgb(239, 68, 68)')
    expect(option('None').querySelector('.pi')).toBeNull()

    // The list is open already: pick from it (Select picks on mousedown).
    option('Food').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await settle()
    const picked = input('tag-default-category')
    expect(picked.textContent?.trim()).toBe('Food')
    expect(picked.querySelector('.pi-gift')).not.toBeNull()
  })

  it('keeps a link to a merchant deleted since', async () => {
    const rewe = await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
    const shop = await tagsRepo.create({ kind: 'location', name: 'Shop' })
    await detailsRepo.setLocation(shop.id, {
      address: null,
      latitude: null,
      longitude: null,
      merchant_id: rewe.id,
    })
    await tagsRepo.softDelete(rewe.id)
    await open('location', shop)
    expect(text()).toContain('Rewe (deleted)')
    await type('tag-address', 'Weg 2')
    await save()
    expect(await detailsRepo.getLocation(shop.id)).toMatchObject({
      address: 'Weg 2',
      merchant_id: rewe.id,
    })
  })

  it("shows a journey's derived dates and resets a typed one", async () => {
    const lisbon = await tagsRepo.create({ kind: 'journey', name: 'Lisbon' })
    const sintra = await tagsRepo.create({ kind: 'journey', name: 'Sintra', parent_id: lisbon.id })
    await detailsRepo.setJourney(sintra.id, { start_date: '2026-07-01', end_date: '2026-07-03' })
    await detailsRepo.setJourney(lisbon.id, { start_date: '2026-06-30', end_date: null })
    await open('journey', lisbon)

    expect(input('tag-start-date').value).toBe('2026-06-30')
    // The end is derived from Sintra's typed end: shown fainter, with its source.
    expect(input('tag-end-date').value).toBe('2026-07-03')
    expect(input('tag-end-date').closest(`[title]`)!.className).toContain(DERIVED_CLASS)

    button('Use the start date from its transactions').click()
    await settle()
    expect(input('tag-start-date').value).toBe('2026-07-01')
    await save()
    expect(await detailsRepo.getJourney(lisbon.id)).toMatchObject({
      start_date: null,
      end_date: null,
    })
  })

  it('removes a merged name so it stops finding the tag', async () => {
    const job = await tagsRepo.create({ kind: 'tag', name: 'job' })
    const work = await tagsRepo.create({ kind: 'tag', name: 'work' })
    await tagsRepo.merge(job.id, work.id)
    await open('tag', (await tagsRepo.findById(work.id))!)
    expect(text()).toContain('job came from tags merged into this one')
    const chip = [...document.querySelectorAll('.p-autocomplete-chip-item')].find((c) =>
      c.textContent?.includes('job'),
    )!
    chip
      .querySelector('.p-chip-remove-icon')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    await save()
    expect(await tagsRepo.findByName('tag', 'job')).toBeNull()
  })

  it("shows the repository's refusal and keeps the dialog open", async () => {
    await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
    const edeka = await tagsRepo.create({ kind: 'merchant', name: 'Edeka' })
    const w = await open('merchant', edeka)
    await type('tag-name', 'rewe')
    await save()
    expect(text()).toContain('Another merchant at this level is already called “rewe”')
    expect(w.emitted('update:visible')).toBeUndefined()
    expect(await tagsRepo.findById(edeka.id)).toMatchObject({ name: 'Edeka' })
  })

  it('deletes after confirming with the use count', async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    const mia = await tagsRepo.create({ kind: 'tag', name: 'mia' })
    await tagsRepo.create({ kind: 'tag', name: 'gifts', parent_id: mia.id })
    await spend(db, await addAccount(db, [mia.id]), food.id, [mia.id])
    await open('tag', mia)
    button('Delete mia').click()
    await settle()
    expect(text()).toContain('Used by 2 transactions or accounts')
    expect(text()).toContain('Its sub-tags move up one level.')
    await save('Delete tag')
    expect(await tagsRepo.findById(mia.id)).toBeNull()
  })

  it('names the sub-categories that move up in the plural', async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    await tagsRepo.create({ kind: 'category', name: 'Groceries', parent_id: food.id })
    await open('category', food)
    button('Delete Food').click()
    await settle()
    expect(text()).toContain('Its sub-categories move up one level.')
  })

  describe('archive', () => {
    it('archives from the footer and closes, with no confirmation', async () => {
      const rewe = await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
      const w = await open('merchant', rewe)
      expect(document.querySelector('[data-archived-note]')).toBeNull()
      expect(() => button('Unarchive Rewe')).toThrow()
      const archive = button('Archive Rewe')
      expect(archive.textContent?.trim()).toBe('Archive')
      expect(archive.querySelector('.pi-inbox')).not.toBeNull()
      // The label hides on narrow screens, like the other footer buttons.
      expect(archive.querySelector('.p-button-label')!.className).toContain('hidden sm:inline')
      archive.click()
      await settle()
      expect((await tagsRepo.findById(rewe.id))!.archived_at_utc).not.toBeNull()
      expect(w.emitted('update:visible')).toEqual([[false]])
    })

    it('says when an archived tag was archived, and unarchives it', async () => {
      const rewe = await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
      await tagsRepo.archive(rewe.id)
      const archived = (await tagsRepo.findById(rewe.id))!
      const w = await open('merchant', archived)
      const day = formatDay(todayLocal(archived.archived_at_utc!))
      expect(document.querySelector('[data-archived-note]')!.textContent).toContain(
        `Archived on ${day}: no longer offered in pickers.`,
      )
      expect(() => button('Archive Rewe')).toThrow()
      button('Unarchive Rewe').click()
      await settle()
      expect((await tagsRepo.findById(rewe.id))!.archived_at_utc).toBeNull()
      expect(w.emitted('update:visible')).toEqual([[false]])
    })

    it('has no archive button for a new tag', async () => {
      await open('merchant', null)
      expect(pageText()).not.toContain('Archive')
    })

    it('does not offer archived tags as a parent or a link', async () => {
      await tagsRepo.create({ kind: 'category', name: 'Food' })
      const old = await tagsRepo.create({ kind: 'category', name: 'Baby food' })
      await tagsRepo.archive(old.id)
      await tagsRepo.create({ kind: 'merchant', name: 'Edeka' })
      const closed = await tagsRepo.create({ kind: 'merchant', name: "Kaiser's" })
      await tagsRepo.archive(closed.id)

      await open('category', null)
      expect((await optionsOf('tag-parent')).map((o) => o.textContent?.trim())).toEqual([
        'None (top level)',
        'Food',
      ])
      wrapper!.unmount()
      document.body.innerHTML = ''

      await open('merchant', null)
      expect((await optionsOf('tag-default-category')).map((o) => o.textContent?.trim())).toEqual([
        'None',
        'Food',
      ])
      wrapper!.unmount()
      document.body.innerHTML = ''

      await open('location', null)
      expect((await optionsOf('tag-merchant')).map((o) => o.textContent?.trim())).toEqual([
        'None',
        'Edeka',
      ])
    })

    it('keeps a link to an archived tag, labelled so, and saves it', async () => {
      const closed = await tagsRepo.create({ kind: 'merchant', name: "Kaiser's" })
      const shop = await tagsRepo.create({ kind: 'location', name: 'Shop' })
      await detailsRepo.setLocation(shop.id, {
        address: null,
        latitude: null,
        longitude: null,
        merchant_id: closed.id,
      })
      await tagsRepo.archive(closed.id)
      await open('location', shop)
      expect(text()).toContain("Kaiser's (archived)")
      await type('tag-address', 'Weg 2')
      await save()
      expect(await detailsRepo.getLocation(shop.id)).toMatchObject({
        address: 'Weg 2',
        merchant_id: closed.id,
      })
    })

    it('keeps an archived parent, labelled so, for a child and a new child', async () => {
      const summer = await tagsRepo.create({ kind: 'journey', name: 'Summer' })
      const lisbon = await tagsRepo.create({
        kind: 'journey',
        name: 'Lisbon',
        parent_id: summer.id,
      })
      await tagsRepo.archive(summer.id)

      await open('journey', lisbon)
      const parent = input('tag-parent').closest('.p-select')!
      expect(parent.textContent?.trim()).toBe('Summer (archived)')
      await type('tag-name', 'Lisboa')
      await save()
      expect(await tagsRepo.findById(lisbon.id)).toMatchObject({
        name: 'Lisboa',
        parent_id: summer.id,
      })
      wrapper!.unmount()
      document.body.innerHTML = ''

      await open('journey', null, summer.id)
      await type('tag-name', 'Porto')
      await save('Add journey')
      expect((await tagsRepo.findByName('journey', 'Porto'))!.parent_id).toBe(summer.id)
    })
  })

  it('offers a merge instead of deleting a category in use', async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    await spend(db, await addAccount(db), food.id)
    const w = await open('category', food)
    button('Delete Food').click()
    await settle()
    expect(text()).toContain('a category in use can only be merged into another one')
    expect(() => button('Delete category')).toThrow()
    ;[...document.querySelectorAll('[role=alert] button')]
      .find((b) => b.textContent?.trim() === 'Merge into…')!
      .dispatchEvent(new Event('click'))
    await settle()
    expect(w.emitted('merge')![0]).toEqual([food])
  })
})
