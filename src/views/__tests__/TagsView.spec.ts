import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { defineComponent, h, type PropType } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { TagsRepository } from '@/db/repositories/TagsRepository'
import { TagDetailsRepository } from '@/db/repositories/TagDetailsRepository'
import { SettingsRepository } from '@/db/repositories/SettingsRepository'
import { LayoutKeys } from '@/stores/layout-types'
import { useLayoutStore } from '@/stores/layout'
import { formatDay } from '@/format/date'
import { DERIVED_CLASS } from '@/components/derived'
import type { MapLocation } from '@/tags/locationsMap'
import {
  button,
  choose,
  input,
  pageText,
  settle,
  stubBrowser,
  type,
} from '@/components/tags/__tests__/dom'
import TagsView from '../TagsView.vue'

// Real store and repositories over an in-memory database; only the
// module-level repository registry is replaced.
let tagsRepo: TagsRepository
let detailsRepo: TagDetailsRepository
let settingsRepo: SettingsRepository
vi.mock('@/db/init', () => ({
  getTagsRepository: () => tagsRepo,
  getTagDetailsRepository: () => detailsRepo,
  getSettingsRepository: () => settingsRepo,
}))

const AT = '2026-10-01T00:00:00.000Z'

// Leaflet does not run in jsdom: the map of all locations is a button per
// location it was given, which asks to edit it, and "Pick all", which asks to
// pick one of them from a list (as a cluster too tight to zoom apart does).
const LocationsMapStub = defineComponent({
  props: { locations: { type: Array as PropType<MapLocation[]>, required: true } },
  emits: ['edit', 'pick'],
  setup(props, { emit }) {
    return () => [
      h(
        'div',
        { 'data-map': '' },
        props.locations.map((l) =>
          h('button', { type: 'button', onClick: () => emit('edit', l.tag.id) }, l.tag.name),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: () =>
            emit(
              'pick',
              props.locations.map((l) => l.tag.id),
            ),
        },
        'Pick all',
      ),
    ]
  },
})

describe('TagsView', () => {
  let db: Database
  let pinia: Pinia
  let router: Router
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
    settingsRepo = new SettingsRepository(db)
    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/tags', component: TagsView }],
    })
  })

  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    await db.close()
  })

  // `transitions`: run Vue's real transitions (stubbed by default), which PrimeVue's
  // Dialog needs to bind its Escape listener.
  async function mountView(path = '/tags', transitions = false) {
    await router.push(path)
    await router.isReady()
    wrapper = mount(TagsView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router, [PrimeVue, { theme: { preset: Aura } }]],
        // Leaflet does not run in jsdom.
        stubs: {
          LocationMap: true,
          LocationsMap: LocationsMapStub,
          ...(transitions ? { transition: false } : {}),
        },
      },
    })
    await settle()
    return wrapper
  }

  /** The names in the tree, in order, indented by two spaces per level. */
  function treeRows(): string[] {
    const list = document.querySelector('ul[aria-label]:not([aria-label^="Deleted"])')
    return [...(list?.querySelectorAll(':scope > li') ?? [])].map((li) => {
      const row = li.firstElementChild as HTMLElement
      const depth = parseFloat(row.style.paddingLeft) / 1.25 || 0
      return '  '.repeat(depth) + li.querySelector('.font-medium')!.textContent!.trim()
    })
  }

  async function foodTree() {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    await tagsRepo.create({ kind: 'category', name: 'snacks', parent_id: food.id })
    await tagsRepo.create({ kind: 'category', name: 'Bakery', parent_id: food.id })
    await tagsRepo.create({ kind: 'category', name: 'cars' })
    return food
  }

  it('opens the tab named in the query', async () => {
    await foodTree()
    await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
    await mountView('/tags?kind=merchant')
    expect(treeRows()).toEqual(['Rewe'])
    expect(document.querySelector('[role=tab][aria-selected=true]')!.textContent).toBe('Merchants')
  })

  it('switches tabs through the URL', async () => {
    await foodTree()
    await mountView()
    ;[...document.querySelectorAll<HTMLElement>('[role=tab]')]
      .find((t) => t.textContent === 'Locations')!
      .click()
    await settle()
    expect(router.currentRoute.value.query.kind).toBe('location')
    expect(pageText()).toContain('Add your first location')
  })

  it('shows the tree nested and sorted', async () => {
    await foodTree()
    await mountView()
    expect(treeRows()).toEqual(['cars', 'Food', '  Bakery', '  snacks'])
  })

  it('collapses and expands a branch', async () => {
    await foodTree()
    await mountView()
    button('Collapse Food').click()
    await settle()
    expect(treeRows()).toEqual(['cars', 'Food'])
    button('Expand Food').click()
    await settle()
    expect(treeRows()).toEqual(['cars', 'Food', '  Bakery', '  snacks'])
  })

  it('filters to matches and their ancestors, by any name', async () => {
    const food = await foodTree()
    await tagsRepo.update(food.id, { synonyms: ['Groceries'] })
    await mountView()
    const filter = document.querySelector<HTMLInputElement>('input[type=search]')!
    filter.value = 'BAK'
    filter.dispatchEvent(new Event('input'))
    await settle()
    expect(treeRows()).toEqual(['Food', '  Bakery'])
    filter.value = 'grocer'
    filter.dispatchEvent(new Event('input'))
    await settle()
    expect(treeRows()).toEqual(['Food'])
    filter.value = 'zzz'
    filter.dispatchEvent(new Event('input'))
    await settle()
    expect(pageText()).toContain('Nothing matches “zzz”.')
  })

  /** The list item of the tag called `name`. */
  const rowOf = (name: string) =>
    [...document.querySelectorAll('li')].find(
      (li) => li.querySelector('.font-medium')?.textContent?.trim() === name,
    )!

  /** The other names on the row of `name`, one per pill. */
  const namesOn = (name: string) =>
    [...rowOf(name).querySelectorAll('[data-names] > li')].map((pill) => pill.textContent?.trim())

  it('shows other names, merged ones included', async () => {
    const lunch = await tagsRepo.create({ kind: 'category', name: 'Lunch' })
    const food = await tagsRepo.create({ kind: 'category', name: 'Food', synonyms: ['Eats'] })
    await tagsRepo.merge(lunch.id, food.id)
    await mountView()
    expect(treeRows()).toEqual(['Food'])
    expect(namesOn('Food')).toEqual(['Eats', 'Lunch'])
  })

  /** The linked tag shown on the row of `name`, as its text. */
  function linkOn(name: string): string | undefined {
    return rowOf(name).querySelector('[data-link]')?.textContent?.replace(/\s+/g, ' ').trim()
  }

  it("shows a merchant's default category, as plain text", async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    const groceries = await tagsRepo.create({
      kind: 'category',
      name: 'Groceries',
      parent_id: food.id,
    })
    const rewe = await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
    await tagsRepo.create({ kind: 'merchant', name: 'Edeka' })
    await detailsRepo.setMerchant(rewe.id, { default_category_id: groceries.id })
    await mountView('/tags?kind=merchant')
    expect(linkOn('Rewe')).toBe('default category: Food › Groceries')
    expect(linkOn('Edeka')).toBeUndefined()
    expect(document.querySelector('main a, ul a')).toBeNull()
  })

  it("shows a location's merchant, marking one deleted since", async () => {
    const rewe = await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
    const mitte = await tagsRepo.create({ kind: 'location', name: 'Rewe Mitte' })
    await detailsRepo.setLocation(mitte.id, {
      address: null,
      latitude: null,
      longitude: null,
      merchant_id: rewe.id,
    })
    await mountView('/tags?kind=location')
    expect(linkOn('Rewe Mitte')).toBe('merchant: Rewe')

    await tagsRepo.softDelete(rewe.id)
    button('Edit Rewe Mitte').click()
    await settle()
    button('Save').click()
    await settle()
    expect(linkOn('Rewe Mitte')).toBe('merchant: Rewe (deleted)')
  })

  it('shows other names as pills, then the description, on every tab', async () => {
    await tagsRepo.create({
      kind: 'tag',
      name: 'mia',
      synonyms: ['Mia K.', 'Mimi'],
      description: 'Our daughter',
    })
    await tagsRepo.create({ kind: 'tag', name: 'plain' })
    await mountView('/tags?kind=tag')
    // One pill per name, in a list screen readers announce as other names.
    expect(namesOn('mia')).toEqual(['Mia K.', 'Mimi'])
    expect(rowOf('mia').querySelector('[data-names]')!.getAttribute('aria-label')).toBe(
      'Other names',
    )
    expect(rowOf('mia').querySelector('[data-description]')?.textContent?.trim()).toBe(
      'Our daughter',
    )
    expect(rowOf('plain').querySelector('[data-names]')).toBeNull()
    expect(rowOf('plain').querySelector('[data-description]')).toBeNull()
  })

  it('keeps the line breaks of a description on detailed rows', async () => {
    await tagsRepo.create({ kind: 'tag', name: 'mia', description: 'Our daughter\nBorn in May' })
    await mountView('/tags?kind=tag')
    const description = rowOf('mia').querySelector('[data-description]')!
    expect(description.textContent).toContain('Our daughter\nBorn in May')
    expect(description.className).toContain('whitespace-pre-line')
  })

  describe('row style', () => {
    async function rewe() {
      const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
      const merchant = await tagsRepo.create({
        kind: 'merchant',
        name: 'Rewe',
        synonyms: ['REWE Markt'],
        description: 'The supermarket',
      })
      await detailsRepo.setMerchant(merchant.id, { default_category_id: food.id })
    }

    it('slim rows keep to one line, showing more on wider screens', async () => {
      await rewe()
      await useLayoutStore().setTagRows('slim')
      await mountView('/tags?kind=merchant')
      const row = rowOf('Rewe')
      expect(row.querySelector('[data-description]')).toBeNull()
      expect(row.querySelector('[data-facts]')).toBeNull()
      // The link from sm up, the other names and description from md up.
      expect(row.querySelector('[data-link]')!.className).toContain('hidden sm:flex')
      const names = row.querySelector('[data-names]')!
      expect(names.className).toContain('hidden')
      expect(names.className).toContain('md:flex')
      // On the name's line, cut at its edge rather than wrapped.
      expect(names.parentElement).toBe(row.querySelector('.font-medium')!.parentElement)
      expect(names.className).toContain('overflow-hidden')
      expect(names.className).not.toContain('flex-wrap')
      expect(namesOn('Rewe')).toEqual(['REWE Markt'])
      const description = row.querySelector('.md\\:block')!
      expect(description.parentElement).toBe(names.parentElement)
      expect(description.textContent?.trim()).toBe('The supermarket')
      expect(description.className).toContain('truncate')
    })

    it('slim rows keep a multi-line description on their one line', async () => {
      await tagsRepo.create({ kind: 'tag', name: 'mia', description: 'Our daughter\nBorn in May' })
      await useLayoutStore().setTagRows('slim')
      await mountView('/tags?kind=tag')
      const row = rowOf('mia')
      expect(row.querySelector('[data-description]')).toBeNull()
      const description = row.querySelector('.md\\:block')!
      expect(description.parentElement).toBe(row.querySelector('.font-medium')!.parentElement)
      expect(description.className).not.toContain('whitespace-pre-line')
    })

    it('switches with the selector and keeps the choice on this device', async () => {
      await rewe()
      await mountView('/tags?kind=merchant')
      expect(rowOf('Rewe').querySelector('[data-description]')).not.toBeNull()
      button('Slim').click()
      await settle()
      expect(rowOf('Rewe').querySelector('[data-description]')).toBeNull()
      expect(await settingsRepo.get(LayoutKeys.tagRows)).toBe('slim')
    })

    it("detailed rows list a location's place, radius and matching", async () => {
      const market = await tagsRepo.create({ kind: 'location', name: 'Market' })
      await detailsRepo.setLocation(market.id, {
        address: 'Weg 1',
        latitude: 52.5,
        longitude: 13.4,
        merchant_id: null,
        radius_metres: 30,
        auto_match: false,
      })
      const spot = await tagsRepo.create({ kind: 'location', name: 'Spot' })
      await detailsRepo.setLocation(spot.id, {
        address: null,
        latitude: 52.52,
        longitude: 13.405,
        merchant_id: null,
      })
      await mountView('/tags?kind=location')
      const facts = (name: string) =>
        rowOf(name).querySelector('[data-facts]')?.textContent?.replace(/\s+/g, ' ').trim()
      expect(facts('Market')).toBe('Weg 1 · within 30 m · not matched automatically')
      expect(facts('Spot')).toBe('52.52, 13.405 · within 10 m')
    })

    it('detailed rows say when a merchant is not matched automatically', async () => {
      await rewe()
      const kiosk = await tagsRepo.create({ kind: 'merchant', name: 'Kiosk' })
      await detailsRepo.setMerchant(kiosk.id, { default_category_id: null, auto_match: false })
      await mountView('/tags?kind=merchant')
      const facts = (name: string) =>
        rowOf(name).querySelector('[data-facts]')?.textContent?.replace(/\s+/g, ' ').trim()
      expect(facts('Kiosk')).toBe('not matched automatically')
      expect(facts('Rewe')).toBeUndefined()
    })

    it("detailed rows list a journey's dates, derived ones fainter", async () => {
      const summer = await tagsRepo.create({ kind: 'journey', name: 'Summer' })
      const lisbon = await tagsRepo.create({
        kind: 'journey',
        name: 'Lisbon',
        parent_id: summer.id,
      })
      await detailsRepo.setJourney(lisbon.id, { start_date: '2026-07-01', end_date: '2026-07-05' })
      await mountView('/tags?kind=journey')
      await settle()
      const parts = (name: string) => [
        ...rowOf(name).querySelectorAll<HTMLElement>('[data-facts] > span:not([aria-hidden])'),
      ]
      const from = `from ${formatDay('2026-07-01')}`
      const to = `to ${formatDay('2026-07-05')}`
      expect(parts('Lisbon').map((p) => p.textContent?.trim())).toEqual([from, to])
      expect(parts('Lisbon').every((p) => !p.className.includes(DERIVED_CLASS))).toBe(true)
      // Summer's dates come from Lisbon's: derived, fainter.
      expect(parts('Summer').map((p) => p.textContent?.trim())).toEqual([from, to])
      expect(parts('Summer').every((p) => p.className.includes(DERIVED_CLASS))).toBe(true)
    })
  })

  describe('map of locations', () => {
    /** Berlin (placed), Rewe Mitte under it (placed), Kiosk and Old Kiosk (no position). */
    async function locations() {
      const berlin = await tagsRepo.create({ kind: 'location', name: 'Berlin' })
      await detailsRepo.setLocation(berlin.id, {
        address: null,
        latitude: 52.52,
        longitude: 13.405,
        merchant_id: null,
        radius_metres: 9000,
      })
      const mitte = await tagsRepo.create({
        kind: 'location',
        name: 'Rewe Mitte',
        parent_id: berlin.id,
      })
      await detailsRepo.setLocation(mitte.id, {
        address: null,
        latitude: 52.523,
        longitude: 13.41,
        merchant_id: null,
        radius_metres: 30,
        auto_match: false,
      })
      await tagsRepo.create({ kind: 'location', name: 'Kiosk' })
      await tagsRepo.create({ kind: 'location', name: 'Old Kiosk', synonyms: ['Rewe Kiosk'] })
      return { berlin, mitte }
    }

    /** The names on the (stubbed) map, or null when no map shows. */
    function onMap(): string[] | null {
      const map = document.querySelector('[data-map]')
      return map && [...map.querySelectorAll('button')].map((b) => b.textContent!.trim())
    }

    const hasButton = (text: string) =>
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === text)

    it('is offered on the Locations tab only', async () => {
      await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
      await locations()
      await mountView('/tags?kind=merchant')
      expect(hasButton('Slim')).toBe(true)
      expect(hasButton('Map')).toBe(false)
      await router.replace({ query: { kind: 'location' } })
      await settle()
      expect(hasButton('Map')).toBe(true)
    })

    it('replaces the list with the placed locations, filtered, and counts the unplaced', async () => {
      await locations()
      await mountView('/tags?kind=location')
      expect(onMap()).toBeNull()
      button('Map').click()
      await settle()
      expect(treeRows()).toEqual([])
      expect(onMap()).toEqual(['Berlin', 'Rewe Mitte'])
      expect(pageText()).toContain('2 locations have no position, so they are not on the map.')
      expect(await settingsRepo.get(LayoutKeys.locationsView)).toBe('map')

      const filter = document.querySelector<HTMLInputElement>('input[type=search]')!
      filter.value = 'rewe'
      filter.dispatchEvent(new Event('input'))
      await settle()
      expect(onMap()).toEqual(['Rewe Mitte'])
      expect(pageText()).toContain('1 location has no position, so it is not on the map.')
      filter.value = 'zzz'
      filter.dispatchEvent(new Event('input'))
      await settle()
      expect(onMap()).toEqual([])
      expect(pageText()).toContain('Nothing matches “zzz”.')
    })

    it('goes back to the list with Slim or Detailed', async () => {
      await locations()
      await useLayoutStore().setLocationsView('map')
      await mountView('/tags?kind=location')
      expect(onMap()).toEqual(['Berlin', 'Rewe Mitte'])
      button('Slim').click()
      await settle()
      expect(onMap()).toBeNull()
      expect(treeRows()).toEqual(['Berlin', '  Rewe Mitte', 'Kiosk', 'Old Kiosk'])
      expect(await settingsRepo.get(LayoutKeys.locationsView)).toBe('list')
      expect(await settingsRepo.get(LayoutKeys.tagRows)).toBe('slim')
      button('Map').click()
      await settle()
      button('Detailed').click()
      await settle()
      expect(onMap()).toBeNull()
      expect(await settingsRepo.get(LayoutKeys.tagRows)).toBe('detailed')
    })

    it('opens the edit dialog for a location picked on the map', async () => {
      await locations()
      await useLayoutStore().setLocationsView('map')
      await mountView('/tags?kind=location')
      button('Rewe Mitte').click()
      await settle()
      expect(document.querySelector('[role=dialog] .p-dialog-title')!.textContent).toBe(
        'Edit location',
      )
      expect(input('tag-name').value).toBe('Rewe Mitte')
    })

    it('lists the locations of a cluster too tight to zoom apart, and edits the one picked', async () => {
      await locations()
      await useLayoutStore().setLocationsView('map')
      await mountView('/tags?kind=location')
      button('Pick all').click()
      await settle()
      const titles = () =>
        [...document.querySelectorAll('[role=dialog] .p-dialog-title')].map((t) => t.textContent)
      expect(titles()).toEqual(['2 locations here'])
      const rows = [...document.querySelectorAll('[role=dialog] li button')]
      expect(rows.map((b) => b.textContent?.trim())).toEqual(['Berlin', 'Rewe Mitte'])
      expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual([
        'Edit Berlin',
        'Edit Rewe Mitte',
      ])

      button('Edit Rewe Mitte').click()
      await settle()
      expect(titles()).toEqual(['Edit location'])
      expect(input('tag-name').value).toBe('Rewe Mitte')
    })
  })

  it('marks duplicates and explains them', async () => {
    for (const id of ['reweA0000001', 'reweB0000001']) {
      await db.run(
        `INSERT INTO tags (id, kind, name, moved_at_utc, created_at_utc, updated_at_utc)
         VALUES (?, 'merchant', 'Rewe', ?, ?, ?)`,
        [id, AT, AT, AT],
      )
    }
    await tagsRepo.create({ kind: 'merchant', name: 'Edeka' })
    await mountView('/tags?kind=merchant')
    expect(document.querySelectorAll('.p-tag').length).toBe(2)
    expect(pageText()).toContain('Some merchants share a name with another one at the same level')
  })

  it('lists deleted tags and restores one', async () => {
    const food = await foodTree()
    const old = await tagsRepo.create({ kind: 'category', name: 'Old', parent_id: food.id })
    await tagsRepo.softDelete(old.id)
    await mountView()
    expect(pageText()).not.toContain('was under Food')
    expect(pageText()).toContain('Show deleted categories (1)')
    input('tags-show-deleted').click()
    await settle()
    expect(document.querySelector('ul[aria-label="Deleted categories"]')).not.toBeNull()
    expect(pageText()).toContain('Old was under Food')
    button('Restore Old').click()
    await settle()
    expect(treeRows()).toContain('  Old')
    expect(pageText()).not.toContain('Show deleted')
  })

  describe('archived tags', () => {
    /** Summer (archived) > Lisbon, Summer > Porto (archived), Winter (archived), Autumn. */
    async function journeys() {
      const summer = await tagsRepo.create({ kind: 'journey', name: 'Summer' })
      await tagsRepo.create({ kind: 'journey', name: 'Lisbon', parent_id: summer.id })
      const porto = await tagsRepo.create({ kind: 'journey', name: 'Porto', parent_id: summer.id })
      const winter = await tagsRepo.create({ kind: 'journey', name: 'Winter' })
      await tagsRepo.create({ kind: 'journey', name: 'Autumn' })
      for (const t of [summer, porto, winter]) await tagsRepo.archive(t.id)
    }

    const archivedRows = () =>
      [...document.querySelectorAll('li')]
        .filter((li) => li.querySelector('[data-archived]'))
        .map((li) => li.querySelector('.font-medium')!.textContent!.trim())
    const marked = (name: string) => rowOf(name).querySelector('.p-tag')?.textContent?.trim()

    it('leave the tree, but an archived parent of active ones stays, faint and marked', async () => {
      await journeys()
      await mountView('/tags?kind=journey')
      expect(treeRows()).toEqual(['Autumn', 'Summer', '  Lisbon'])
      expect(archivedRows()).toEqual(['Summer'])
      expect(rowOf('Summer').querySelector('[data-archived]')!.className).toContain('opacity-60')
      expect(marked('Summer')).toBe('Archived')
      expect(marked('Lisbon')).toBeUndefined()
    })

    it('show with the toggle of their tab, and the filter applies to them', async () => {
      await journeys()
      await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
      await mountView('/tags?kind=journey')
      expect(pageText()).toContain('Show archived journeys (3)')
      input('tags-show-archived').click()
      await settle()
      expect(treeRows()).toEqual(['Autumn', 'Summer', '  Lisbon', '  Porto', 'Winter'])
      expect(archivedRows()).toEqual(['Summer', 'Porto', 'Winter'])

      const filter = document.querySelector<HTMLInputElement>('input[type=search]')!
      filter.value = 'win'
      filter.dispatchEvent(new Event('input'))
      await settle()
      expect(treeRows()).toEqual(['Winter'])

      // The toggle is the tab's own: another tab has none to show.
      await router.replace({ query: { kind: 'merchant' } })
      await settle()
      expect(pageText()).not.toContain('Show archived')
      await router.replace({ query: { kind: 'journey' } })
      await settle()
      expect(input('tags-show-archived').checked).toBe(true)
    })

    it('hide an archived parent whose active children the filter leaves out', async () => {
      await journeys()
      await mountView('/tags?kind=journey')
      const filter = document.querySelector<HTMLInputElement>('input[type=search]')!
      filter.value = 'summer'
      filter.dispatchEvent(new Event('input'))
      await settle()
      expect(pageText()).toContain('Nothing matches “summer”.')
      filter.value = 'lis'
      filter.dispatchEvent(new Event('input'))
      await settle()
      expect(treeRows()).toEqual(['Summer', '  Lisbon'])
    })

    it('says so when every tag of the tab is archived', async () => {
      const old = await tagsRepo.create({ kind: 'merchant', name: "Kaiser's" })
      await tagsRepo.archive(old.id)
      await mountView('/tags?kind=merchant')
      expect(pageText()).toContain('Every merchant is archived.')
      expect(pageText()).not.toContain('Add your first merchant')
      input('tags-show-archived').click()
      await settle()
      expect(treeRows()).toEqual(["Kaiser's"])
    })

    it('leave the map unless shown, then are drawn faint', async () => {
      const berlin = await tagsRepo.create({ kind: 'location', name: 'Berlin' })
      const closed = await tagsRepo.create({ kind: 'location', name: "Kaiser's" })
      await tagsRepo.create({ kind: 'location', name: 'Unplaced closed' })
      for (const t of [berlin, closed]) {
        await detailsRepo.setLocation(t.id, {
          address: null,
          latitude: 52.52,
          longitude: 13.405,
          merchant_id: null,
        })
      }
      await tagsRepo.archive(closed.id)
      await tagsRepo.archive((await tagsRepo.findByName('location', 'Unplaced closed'))!.id)
      await useLayoutStore().setLocationsView('map')
      await mountView('/tags?kind=location')
      const onMap = () =>
        [...document.querySelectorAll('[data-map] button')].map((b) => b.textContent!.trim())
      expect(onMap()).toEqual(['Berlin'])
      expect(pageText()).not.toContain('no position')
      input('tags-show-archived').click()
      await settle()
      expect(onMap()).toEqual(['Berlin', "Kaiser's"])
      expect(pageText()).toContain('1 location has no position')
    })

    it('archives from the edit dialog, and unarchives from the shown list', async () => {
      await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
      await tagsRepo.create({ kind: 'merchant', name: 'Edeka' })
      await mountView('/tags?kind=merchant')
      button('Edit Rewe').click()
      await settle()
      button('Archive Rewe').click()
      await settle()
      expect(document.querySelector('[role=dialog]')).toBeNull()
      expect(treeRows()).toEqual(['Edeka'])

      input('tags-show-archived').click()
      await settle()
      button('Edit Rewe').click()
      await settle()
      button('Unarchive Rewe').click()
      await settle()
      expect(treeRows()).toEqual(['Edeka', 'Rewe'])
      expect(archivedRows()).toEqual([])
      expect(pageText()).not.toContain('Show archived')
    })
  })

  it('shows an empty state per kind', async () => {
    await mountView('/tags?kind=journey')
    expect(pageText()).toContain('Trips and stays')
    button('Add your first journey').click()
    await settle()
    expect(pageText()).toContain('New journey')
  })

  it('adds a child from a row', async () => {
    await foodTree()
    await mountView()
    button('Add a category under Food').click()
    await settle()
    await type('tag-name', 'Drinks')
    button('Add category').click()
    await settle()
    expect(treeRows()).toEqual(['cars', 'Food', '  Bakery', '  Drinks', '  snacks'])
  })

  it('Escape in the merge dialog leaves the edit dialog and its draft open', async () => {
    await tagsRepo.create({ kind: 'category', name: 'Lunch' })
    await tagsRepo.create({ kind: 'category', name: 'Food' })
    await mountView('/tags', true)
    button('Edit Lunch').click()
    await settle()
    await type('tag-name', 'Lunches')
    button('Merge Lunch into another category').click()
    await settle()
    // The dialogs bind their Escape listener once their enter transition ran.
    await new Promise((r) => setTimeout(r, 100))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }))
    await settle()
    await new Promise((r) => setTimeout(r, 100)) // the leave transitions
    const headers = [...document.querySelectorAll('[role=dialog] .p-dialog-title')].map(
      (h) => h.textContent,
    )
    expect(headers).toEqual(['Edit category'])
    expect(input('tag-name').value).toBe('Lunches')
  })

  it('merges from the edit dialog and updates the tree', async () => {
    await foodTree()
    await tagsRepo.create({ kind: 'category', name: 'Lunch' })
    await mountView()
    button('Edit Lunch').click()
    await settle()
    button('Merge Lunch into another category').click()
    await settle()
    await choose('merge-target', 'Food')
    button('Merge').click()
    await settle()
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(treeRows()).toEqual(['cars', 'Food', '  Bakery', '  snacks'])
    expect(pageText()).toContain('Lunch')
  })
})
