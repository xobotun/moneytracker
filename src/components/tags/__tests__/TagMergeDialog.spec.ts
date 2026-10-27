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

  it('warns with the use count before merging', async () => {
    const mia = await tagsRepo.create({ kind: 'tag', name: 'mia' })
    await tagsRepo.create({ kind: 'tag', name: 'family' })
    const food = await tagsRepo.create({ kind: 'category', name: 'Food' })
    await spend(db, await addAccount(db, [mia.id]), food.id, [mia.id])
    await open(mia)
    await choose('merge-target', 'family')
    expect(pageText()).toContain('“mia” will be deleted. Its 2 uses move to family.')
    expect(pageText()).toContain('Its names become other names of family')
    expect(await tagsRepo.findById(mia.id)).not.toBeNull()
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
