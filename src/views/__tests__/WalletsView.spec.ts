import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { AccountsRepository } from '@/db/repositories/AccountsRepository'
import { TransactionsRepository } from '@/db/repositories/TransactionsRepository'
import { zeroMoney } from '@/db/MoneyAmount'
import WalletsView from '../WalletsView.vue'

// Real store and repositories over an in-memory database; only the
// module-level repository registry is replaced.
let accountsRepo: AccountsRepository
let transactionsRepo: TransactionsRepository
vi.mock('@/db/init', () => ({
  getAccountsRepository: () => accountsRepo,
  getTransactionsRepository: () => transactionsRepo,
}))

function seed(name: string) {
  return accountsRepo.create({
    name,
    balance: zeroMoney('EUR'),
    tags: [],
    location_id: null,
    colour: '#3b82f6',
    icon: 'wallet',
  })
}

describe('WalletsView', () => {
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
    transactionsRepo = new TransactionsRepository(db)
  })

  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    await db.close()
  })

  async function mountView() {
    wrapper = mount(WalletsView, {
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

  it('shows an empty state with a way to add the first wallet', async () => {
    const w = await mountView()
    expect(w.text()).toContain('No wallets yet')
    expect(buttonByText('Add your first wallet')).toBeTruthy()
  })

  it('lists wallets in their stored order', async () => {
    await seed('Cash')
    await seed('Bank')
    const w = await mountView()
    expect(listedNames(w)).toEqual(['Cash', 'Bank'])
    expect(w.text()).toContain('EUR')
  })

  it('adds a wallet through the dialog', async () => {
    const w = await mountView()
    buttonByText('Add your first wallet').click()
    await settle()

    const name = document.getElementById('wallet-name') as HTMLInputElement
    name.value = 'Travel card'
    name.dispatchEvent(new Event('input'))
    const currency = document.getElementById('wallet-currency') as HTMLInputElement
    currency.value = 'gbp'
    currency.dispatchEvent(new Event('input'))
    await settle()

    buttonByText('Add wallet').click()
    await settle()

    expect(listedNames(w)).toEqual(['Travel card'])
    const [saved] = await accountsRepo.list()
    expect(saved!.balance).toEqual(zeroMoney('GBP'))
  })

  it('shows validation errors instead of saving an empty wallet', async () => {
    const w = await mountView()
    buttonByText('Add your first wallet').click()
    await settle()
    buttonByText('Add wallet').click()
    await settle()

    expect(document.body.textContent).toContain('Give the wallet a name.')
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

  it('opens the editor with the wallet filled in and saves changes', async () => {
    await seed('Cash')
    const w = await mountView()
    await w.find('button[title="Edit Cash"]').trigger('click')
    await settle()

    const name = document.getElementById('wallet-name') as HTMLInputElement
    expect(name.value).toBe('Cash')
    name.value = 'Pocket money'
    name.dispatchEvent(new Event('input'))
    await settle()
    buttonByText('Save').click()
    await settle()

    expect(listedNames(w)).toEqual(['Pocket money'])
  })
})
