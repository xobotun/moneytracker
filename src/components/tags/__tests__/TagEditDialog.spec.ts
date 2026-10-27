import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { TagsRepository } from '@/db/repositories/TagsRepository'
import { TagDetailsRepository } from '@/db/repositories/TagDetailsRepository'
import { AccountsRepository } from '@/db/repositories/AccountsRepository'
import { TransactionsRepository } from '@/db/repositories/TransactionsRepository'
import { zeroMoney, moneyAmount } from '@/db/MoneyAmount'
import { localMoment } from '@/db/LocalMoment'
import type { Tag, TagKind } from '@/db/types'
import type { ShortId } from '@/db/shortId'
import { DERIVED_CLASS } from '@/components/derived'
import { useTagsStore } from '@/stores/tags'
import TagEditDialog from '../TagEditDialog.vue'

// Real store and repositories over an in-memory database; only the
// module-level repository registry is replaced.
let tagsRepo: TagsRepository
let detailsRepo: TagDetailsRepository
vi.mock('@/db/init', () => ({
  getTagsRepository: () => tagsRepo,
  getTagDetailsRepository: () => detailsRepo,
}))

describe('TagEditDialog', () => {
  let db: Database
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
    // The auto-resizing description watches its size; jsdom has no ResizeObserver.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

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

  // Waits for SQLite work started by a click (the async build yields to the event loop).
  async function settle() {
    for (let i = 0; i < 5; i++) {
      await flushPromises()
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  async function open(kind: TagKind, tag: Tag | null, parentId: ShortId | null = null) {
    await useTagsStore().load()
    wrapper = mount(TagEditDialog, {
      attachTo: document.body,
      props: { kind, tag, parentId, visible: true },
      global: { plugins: [pinia, [PrimeVue, { theme: { preset: Aura } }]] },
    })
    await settle()
    return wrapper
  }

  function button(text: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
    )
    if (!found) throw new Error(`no button "${text}"`)
    return found
  }

  function input(id: string): HTMLInputElement {
    return document.getElementById(id) as HTMLInputElement
  }

  async function type(id: string, value: string) {
    const field = input(id)
    field.value = value
    field.dispatchEvent(new Event('input'))
    await settle()
  }

  /** Picks `label` in the Select whose input id is `id`. */
  async function choose(id: string, label: string) {
    ;(input(id).closest('.p-select') as HTMLElement).click()
    await settle()
    const option = [
      ...document.querySelectorAll<HTMLElement>('.p-select-overlay [role=option]'),
    ].find((o) => o.textContent?.trim() === label)
    if (!option) throw new Error(`no option "${label}"`)
    // Select picks an option on mousedown.
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await settle()
  }

  async function save(label = 'Save') {
    button(label).click()
    await settle()
  }

  const text = () => document.body.textContent ?? ''

  /** Records a 5 € expense from `accountId` in `categoryId` with the plain `tags`. */
  async function spend(accountId: ShortId, categoryId: ShortId, tags: ShortId[]) {
    const amount = moneyAmount(500, 2, 'EUR')
    await new TransactionsRepository(db).create({
      account_id__from: accountId,
      account_id__to: null,
      amount__from: amount,
      amount__to: amount,
      categories: [{ category_id: categoryId, amount__from: amount, amount__to: amount }],
      location_id: null,
      location_lat: null,
      location_lon: null,
      tags,
      transaction_at: localMoment('2026-07-01T12:00:00.000+02:00', 'Europe/Berlin'),
      date_override: null,
    })
  }

  it('creates a top-level category with a preset colour and the kind icon', async () => {
    const w = await open('category', null)
    expect(text()).toContain('New category')
    await type('tag-name', 'Food')
    await save('Add category')
    const food = await tagsRepo.findByName('category', 'Food', null)
    expect(food).toMatchObject({ icon: 'tag' })
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
      icon: 'tag',
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

  it('does not offer the tag itself or its descendants as a parent', async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    await tagsRepo.create({ kind: 'category', name: 'Groceries', parent_id: food.id })
    await tagsRepo.create({ kind: 'category', name: 'Fun' })
    await open('category', food)
    ;(input('tag-parent').closest('.p-select') as HTMLElement).click()
    await settle()
    const options = [...document.querySelectorAll('.p-select-overlay [role=option]')].map((o) =>
      o.textContent?.trim(),
    )
    expect(options).toEqual(['None (top level)', 'Fun'])
  })

  it('shows the inherited colour as derived and resets an own one', async () => {
    const food = await tagsRepo.create({
      kind: 'category',
      name: 'Food',
      colour: '#ef4444',
      icon: 'tag',
    })
    const snacks = await tagsRepo.create({
      kind: 'category',
      name: 'Snacks',
      parent_id: food.id,
      colour: '#3b82f6',
    })
    await open('category', snacks)
    expect(text()).toContain('Inherited: from Food') // the icon
    button('Use the colour from Food').click()
    await settle()
    const picker = document.querySelector('[title="Inherited: from Food"]')!
    expect(picker.className).toContain(DERIVED_CLASS)
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
    })
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
    const accounts = new AccountsRepository(db)
    const cash = await accounts.create({
      name: 'Cash',
      balance: zeroMoney('EUR'),
      tags: [mia.id],
      location_id: null,
      grouping_id: null,
      colour: '#3b82f6',
      icon: 'wallet',
    })
    await spend(cash.id, food.id, [mia.id])
    await open('tag', mia)
    button('Delete mia').click()
    await settle()
    expect(text()).toContain('Used by 2 transactions or accounts')
    expect(text()).toContain('Its sub-tags move up one level.')
    await save('Delete tag')
    expect(await tagsRepo.findById(mia.id)).toBeNull()
  })

  it('offers a merge instead of deleting a category in use', async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    const accounts = new AccountsRepository(db)
    const cash = await accounts.create({
      name: 'Cash',
      balance: zeroMoney('EUR'),
      tags: [],
      location_id: null,
      grouping_id: null,
      colour: '#3b82f6',
      icon: 'wallet',
    })
    await spend(cash.id, food.id, [])
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
