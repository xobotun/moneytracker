import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { AccountsRepository } from '@/db/repositories/AccountsRepository'
import { AccountGroupingsRepository } from '@/db/repositories/AccountGroupingsRepository'
import { TransactionsRepository } from '@/db/repositories/TransactionsRepository'
import { zeroMoney } from '@/db/MoneyAmount'
import AccountsView from '../AccountsView.vue'

// Real store and repositories over an in-memory database; only the
// module-level repository registry is replaced.
let accountsRepo: AccountsRepository
let groupingsRepo: AccountGroupingsRepository
let transactionsRepo: TransactionsRepository
vi.mock('@/db/init', () => ({
  getAccountsRepository: () => accountsRepo,
  getAccountGroupingsRepository: () => groupingsRepo,
  getTransactionsRepository: () => transactionsRepo,
}))

function seed(name: string) {
  return accountsRepo.create({
    name,
    balance: zeroMoney('EUR'),
    tags: [],
    location_id: null,
    grouping_id: null,
    colour: '#3b82f6',
    icon: 'wallet',
  })
}

describe('AccountsView', () => {
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
    accountsRepo = new AccountsRepository(db)
    groupingsRepo = new AccountGroupingsRepository(db)
    transactionsRepo = new TransactionsRepository(db)
  })

  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    await db.close()
  })

  async function mountView() {
    wrapper = mount(AccountsView, {
      attachTo: document.body,
      global: { plugins: [pinia, [PrimeVue, { theme: { preset: Aura } }]] },
    })
    await flushPromises()
    return wrapper
  }

  // Waits for SQLite work started by a click (the async build yields to the event loop).
  async function settle() {
    for (let i = 0; i < 5; i++) {
      await flushPromises()
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  const listedNames = (w: VueWrapper) => w.findAll('li .font-medium').map((n) => n.text())

  function buttonByText(text: string): HTMLButtonElement {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    )
    if (!button) throw new Error(`no button "${text}"`)
    return button
  }

  it('shows an empty state with a way to add the first account', async () => {
    const w = await mountView()
    expect(w.text()).toContain('No accounts yet')
    expect(buttonByText('Add your first account')).toBeTruthy()
  })

  it('lists accounts in their stored order', async () => {
    await seed('Cash')
    await seed('Bank')
    const w = await mountView()
    expect(listedNames(w)).toEqual(['Cash', 'Bank'])
    expect(w.text()).toContain('EUR')
  })

  it('adds an account through the dialog', async () => {
    const w = await mountView()
    buttonByText('Add your first account').click()
    await settle()

    const name = document.getElementById('account-name') as HTMLInputElement
    name.value = 'Travel card'
    name.dispatchEvent(new Event('input'))
    const currency = document.getElementById('account-currency') as HTMLInputElement
    currency.value = 'gbp'
    currency.dispatchEvent(new Event('input'))
    await settle()

    buttonByText('Add account').click()
    await settle()

    expect(listedNames(w)).toEqual(['Travel card'])
    const [saved] = await accountsRepo.list()
    expect(saved!.balance).toEqual(zeroMoney('GBP'))
  })

  it('shows validation errors instead of saving an empty account', async () => {
    const w = await mountView()
    buttonByText('Add your first account').click()
    await settle()
    buttonByText('Add account').click()
    await settle()

    expect(document.body.textContent).toContain('Give the account a name.')
    expect(listedNames(w)).toEqual([])
    expect(await accountsRepo.list()).toEqual([])
  })

  it('reorders with the arrow buttons and persists the order', async () => {
    await seed('A')
    await seed('B')
    await seed('C')
    const w = await mountView()

    buttonByText('Reorder').click()
    await settle()
    expect(w.find('[aria-label="Move A up"]').attributes('disabled')).toBeDefined()

    await w.find('[aria-label="Move A down"]').trigger('click')
    await settle()
    expect(listedNames(w)).toEqual(['B', 'A', 'C'])

    await w.find('[aria-label="Move C up"]').trigger('click')
    await settle()
    expect(listedNames(w)).toEqual(['B', 'C', 'A'])
    expect((await accountsRepo.list()).map((a) => a.name)).toEqual(['B', 'C', 'A'])
  })

  it('opens the editor with the account filled in and saves changes', async () => {
    await seed('Cash')
    const w = await mountView()
    await w.find('button[aria-label="Edit Cash"]').trigger('click')
    await settle()

    const name = document.getElementById('account-name') as HTMLInputElement
    expect(name.value).toBe('Cash')
    name.value = 'Pocket money'
    name.dispatchEvent(new Event('input'))
    await settle()
    buttonByText('Save').click()
    await settle()

    expect(listedNames(w)).toEqual(['Pocket money'])
  })

  it('has a real Edit button whose text hides on narrow screens', async () => {
    await seed('Cash')
    const w = await mountView()
    const edit = w.find('button[aria-label="Edit Cash"]')
    expect(edit.text()).toBe('Edit')
    expect(edit.find('.p-button-label').classes()).toEqual(
      expect.arrayContaining(['hidden', 'sm:inline']),
    )
  })

  it('picks an icon from the full list by searching', async () => {
    await seed('Cash')
    const w = await mountView()
    await w.find('button[aria-label="Edit Cash"]').trigger('click')
    await settle()

    document.querySelector<HTMLButtonElement>('button[aria-label="All icons"]')!.click()
    await settle()
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search icons"]')!
    search.value = 'eur'
    search.dispatchEvent(new Event('input'))
    await settle()
    const results = [...document.querySelectorAll('[role=dialog][aria-label="All icons"] button')]
    expect(results.map((b) => b.getAttribute('aria-label'))).toEqual(['euro'])
    ;(results[0] as HTMLButtonElement).click()
    await settle()

    // The trigger now shows the picked icon, since it is not a quick one.
    expect(document.querySelector('button[aria-label="All icons, selected: euro"]')).not.toBeNull()
    buttonByText('Save').click()
    await settle()
    expect((await accountsRepo.list())[0]!.icon).toBe('euro')
  })

  it('shows the symbol and name of each currency in the suggestions', async () => {
    await mountView()
    buttonByText('Add your first account').click()
    await settle()

    const currency = document.getElementById('account-currency') as HTMLInputElement
    currency.value = 'rub'
    currency.dispatchEvent(new Event('input'))
    // AutoComplete waits 300 ms after typing before it searches.
    await new Promise((r) => setTimeout(r, 400))
    await settle()

    // Scoped to the overlay: the tags input sits in a role=option item too.
    const options = [...document.querySelectorAll('.p-autocomplete-overlay [role=option]')].map(
      (o) => [...o.querySelectorAll('span > span')].map((s) => s.textContent!.trim()),
    )
    expect(options[0]).toEqual(['RUB', '₽', 'Russian Ruble'])
  })

  describe('groups', () => {
    // Section label → account names, as rendered.
    const layout = (w: VueWrapper) =>
      Object.fromEntries(
        w
          .findAll('section')
          .map((s) => [
            s.attributes('aria-label'),
            s.findAll('li .font-medium').map((n) => n.text()),
          ]),
      )

    async function addGroup(name: string) {
      buttonByText('Add group').click()
      await settle()
      const input = document.getElementById('grouping-name') as HTMLInputElement
      input.value = name
      input.dispatchEvent(new Event('input'))
      await settle()
      const dialog = document.querySelector('.p-dialog')!
      ;[...dialog.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === 'Add group')!
        .click()
      await settle()
    }

    it('keeps group controls behind Reorder', async () => {
      await seed('Cash')
      const w = await mountView()
      expect(w.text()).not.toContain('Add group')
      buttonByText('Reorder').click()
      await settle()
      expect(buttonByText('Add group')).toBeTruthy()
      expect(w.text()).not.toContain('Add account')
    })

    it('creates a group and moves an account into it with the arrows', async () => {
      await seed('Cash')
      await seed('Card')
      const w = await mountView()
      buttonByText('Reorder').click()
      await settle()
      await addGroup('Trip')
      expect(layout(w)).toEqual({ Trip: [], 'Accounts in no group': ['Cash', 'Card'] })

      // Up from the first ungrouped account crosses into the group above.
      await w.find('[aria-label="Move Cash up"]').trigger('click')
      await settle()
      expect(layout(w)).toEqual({ Trip: ['Cash'], 'Accounts in no group': ['Card'] })
      expect(w.find('[aria-label="Move Cash up"]').attributes('disabled')).toBeDefined()
      // The row is a new element in the group; focus lands on its other arrow.
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Cash down')
      const [cash] = await accountsRepo.list()
      expect(cash!.grouping_id).toBe((await groupingsRepo.list())[0]!.id)
    })

    it('shows groups outside reorder mode, without their controls', async () => {
      const trip = await groupingsRepo.create({ name: 'Trip', colour: '#000000', icon: 'car' })
      await accountsRepo.create({
        name: 'Card',
        balance: zeroMoney('EUR'),
        tags: [],
        location_id: null,
        grouping_id: trip.id,
        colour: '#3b82f6',
        icon: 'credit-card',
      })
      await seed('Cash')
      const w = await mountView()
      expect(layout(w)).toEqual({ Trip: ['Card'], 'Accounts in no group': ['Cash'] })
      expect(w.find('[aria-label="Edit group Trip"]').exists()).toBe(false)
      expect(w.find('[aria-label="Move group Trip up"]').exists()).toBe(false)
    })

    it('reorders groups with their arrows', async () => {
      await groupingsRepo.create({ name: 'Trip', colour: '#000000', icon: 'car' })
      await groupingsRepo.create({ name: 'Home', colour: '#000000', icon: 'home' })
      const w = await mountView()
      buttonByText('Reorder').click()
      await settle()
      await w.find('[aria-label="Move group Home up"]').trigger('click')
      await settle()
      expect((await groupingsRepo.list()).map((g) => g.name)).toEqual(['Home', 'Trip'])
      expect(Object.keys(layout(w))).toEqual(['Home', 'Trip', 'Accounts in no group'])
    })

    it('deletes a group and keeps its accounts below the groups', async () => {
      const trip = await groupingsRepo.create({ name: 'Trip', colour: '#000000', icon: 'car' })
      await accountsRepo.create({
        name: 'Card',
        balance: zeroMoney('EUR'),
        tags: [],
        location_id: null,
        grouping_id: trip.id,
        colour: '#3b82f6',
        icon: 'credit-card',
      })
      const w = await mountView()
      buttonByText('Reorder').click()
      await settle()
      await w.find('[aria-label="Edit group Trip"]').trigger('click')
      await settle()
      buttonByText('Delete').click()
      await settle()
      expect(document.body.textContent).toContain('Its account stays and moves below the groups.')
      buttonByText('Delete group').click()
      await settle()

      expect(await groupingsRepo.list()).toEqual([])
      expect(layout(w)).toEqual({ 'Accounts in no group': ['Card'] })
    })
  })
})
