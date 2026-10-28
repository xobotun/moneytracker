import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { TagsRepository } from '@/db/repositories/TagsRepository'
import { TagDetailsRepository } from '@/db/repositories/TagDetailsRepository'
import type { Tag } from '@/db/types'
import { useTagsStore } from '@/stores/tags'
import TagMergeDialog from '../TagMergeDialog.vue'
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

describe('TagMergeDialog', () => {
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

  async function open(source: Tag) {
    await useTagsStore().load()
    wrapper = mount(TagMergeDialog, {
      attachTo: document.body,
      props: { source, visible: true },
      global: { plugins: [pinia, [PrimeVue, { theme: { preset: Aura } }]] },
    })
    await settle()
    return wrapper
  }

  async function pick(field: string, choice: 'source' | 'target' | 'other') {
    input(`merge-${field}-${choice}`).click()
    await settle()
  }

  async function twoLocations() {
    const a = await tagsRepo.create({ kind: 'location', name: 'REWE Mitte' })
    const b = await tagsRepo.create({ kind: 'location', name: 'REWE Markt' })
    const at = (address: string, latitude: number) => ({
      address,
      latitude,
      longitude: 13.4,
      merchant_id: null,
    })
    await detailsRepo.setLocation(a.id, at('Weg 1', 52.5))
    await detailsRepo.setLocation(b.id, at('Weg 2', 52.6))
    return { a, b }
  }

  it("lists targets of the same kind without the source's subtree", async () => {
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    await tagsRepo.create({ kind: 'category', name: 'Groceries', parent_id: food.id })
    const fun = await tagsRepo.create({ kind: 'category', name: 'Fun' })
    await tagsRepo.create({ kind: 'category', name: 'Games', parent_id: fun.id })
    await tagsRepo.create({ kind: 'merchant', name: 'Rewe' })
    await open(food)
    expect((await optionsOf('merge-target')).map((o) => o.textContent?.trim())).toEqual([
      'Fun',
      'Fun › Games',
    ])
  })

  /** The texts of the elements matching `selector` in the merge warning, whitespace collapsed. */
  const inWarning = (selector: string) =>
    [...document.querySelectorAll(`[role=status] ${selector}`)].map((el) =>
      el.textContent?.replace(/\s+/g, ' ').trim(),
    )

  /** The sentences of the merge warning, one per line (the names' pills are not one). */
  const warning = () => inWarning('p')

  /** The names the warning shows as moving, one per pill. */
  const movingNames = () => inWarning('ul[aria-label="Names that move"] > li')

  it('warns with the use count before merging', async () => {
    const mia = await tagsRepo.create({ kind: 'tag', name: 'mia' })
    await tagsRepo.create({ kind: 'tag', name: 'family' })
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    await spend(db, await addAccount(db, [mia.id]), food.id, [mia.id])
    await open(mia)
    await choose('merge-target', 'family')
    expect(warning()).toEqual([
      'mia will be deleted.',
      'Its 2 uses move to family.',
      'These names become other names of family:',
      'family keeps its colour, icon and description.',
    ])
    expect(movingNames()).toEqual(['mia'])
    expect(await tagsRepo.findById(mia.id)).not.toBeNull()
  })

  it('names the source by its name and the target by its path, as chips in their looks', async () => {
    const lunch = await tagsRepo.create({
      kind: 'category',
      name: 'Lunch',
      colour: '#aa0000',
      icon: 'car',
    })
    await tagsRepo.create({ kind: 'category', name: 'Sandwich', parent_id: lunch.id })
    const fun = await tagsRepo.create({
      kind: 'category',
      name: 'Fun',
      colour: '#0000aa',
      icon: 'shop',
    })
    await tagsRepo.create({ kind: 'category', name: 'Games', parent_id: fun.id })
    await open(lunch)
    await choose('merge-target', 'Fun › Games')

    expect(inWarning('[data-tag=source]')).toEqual(['Lunch'])
    // The target inherits its look from Fun.
    const targets = inWarning('[data-tag=target]')
    expect(targets.length).toBeGreaterThan(1)
    expect(new Set(targets)).toEqual(new Set(['Fun › Games']))
    const icon = (chip: string) =>
      document.querySelector<HTMLElement>(`[role=status] [data-tag=${chip}] [aria-hidden=true]`)!
    expect(icon('source').className).toContain('pi-car')
    expect(icon('source').style.color).toBe('rgb(170, 0, 0)')
    expect(icon('target').className).toContain('pi-shop')
    expect(icon('target').style.color).toBe('rgb(0, 0, 170)')
    expect(warning()).toContain('Its sub-categories move under Fun › Games.')
  })

  /** A category called `name` with `synonyms`, under Meals: siblings cannot share names. */
  async function meal(name: string, synonyms: string[] = []) {
    const meals = await tagsRepo.create({ kind: 'category', name: 'Meals' })
    return tagsRepo.create({ kind: 'category', name, synonyms, parent_id: meals.id })
  }

  it('lists as pills only the names the target does not have yet', async () => {
    const lunch = await meal('Lunch', ['Midday'])
    await tagsRepo.create({ kind: 'category', name: 'Food', synonyms: ['lunch'] })
    await spend(db, await addAccount(db), lunch.id)
    await open(lunch)
    await choose('merge-target', 'Food')
    expect(movingNames()).toEqual(['Midday'])
    expect(warning()).toEqual([
      'Lunch will be deleted.',
      'Its 1 use moves to Food (parts of one transaction in both are added together).',
      'These names become other names of Food:',
      'Food keeps its colour, icon and description.',
    ])
  })

  it('says so when the target has every name already', async () => {
    const lunch = await meal('Lunch')
    await tagsRepo.create({ kind: 'category', name: 'Food', synonyms: ['LUNCH'] })
    await open(lunch)
    await choose('merge-target', 'Food')
    expect(warning()).toContain('Its names are already other names of Food.')
    expect(warning().join(' ')).not.toContain('These names')
    expect(movingNames()).toEqual([])
  })

  it('merges and emits merged', async () => {
    const lunch = await tagsRepo.create({ kind: 'category', name: 'Lunch' })
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    const w = await open(lunch)
    expect(button('Merge').disabled).toBe(true)
    await choose('merge-target', 'Food')
    button('Merge').click()
    await settle()
    expect(await tagsRepo.findById(lunch.id)).toBeNull()
    expect((await tagsRepo.findById(food.id))!.synonyms).toEqual(['Lunch'])
    expect(w.emitted('merged')).toHaveLength(1)
    expect(w.emitted('update:visible')).toEqual([[false]])
  })

  it('asks for each conflicting detail and passes the answers', async () => {
    const { a, b } = await twoLocations()
    await open(a)
    await choose('merge-target', 'REWE Markt')
    expect(pageText()).toContain('Address: the two differ')
    expect(pageText()).toContain('Position: the two differ')
    await pick('address', 'other')
    await type('merge-address-value', 'Weg 3')
    await pick('position', 'source')
    button('Merge').click()
    await settle()
    expect(await detailsRepo.getLocation(b.id)).toMatchObject({
      address: 'Weg 3',
      latitude: 52.5,
    })
  })

  it('keeps Merge disabled until every conflict is answered', async () => {
    const { a } = await twoLocations()
    await open(a)
    await choose('merge-target', 'REWE Markt')
    expect(button('Merge').disabled).toBe(true)
    await pick('address', 'target')
    expect(button('Merge').disabled).toBe(true)
    await pick('position', 'target')
    expect(button('Merge').disabled).toBe(false)
  })
})
