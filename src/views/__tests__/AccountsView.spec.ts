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
import { moneyAmount, zeroMoney } from '@/db/MoneyAmount'
import { localMoment } from '@/db/LocalMoment'
import type { ExchangeRate } from '@/db/types'
import type { UUID } from '@/db/uuid'
import { formatApprox, formatMoney } from '@/format/currency'
import AccountsView from '../AccountsView.vue'

// Real store and repositories over an in-memory database; only the
// module-level repository registry is replaced.
let accountsRepo: AccountsRepository
let groupingsRepo: AccountGroupingsRepository
let rateRows: ExchangeRate[] = []
let transactionsRepo: TransactionsRepository
vi.mock('@/db/init', () => ({
  getAccountsRepository: () => accountsRepo,
  getExchangeRatesRepository: () => ({ latest: async () => rateRows }),
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
    rateRows = []
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

  describe('touch dragging from the grip', () => {
    // jsdom has no layout: elementFromPoint is stubbed to "what is under the finger".
    let under: Element | null = null
    beforeEach(() => {
      document.elementFromPoint = () => under
    })

    function pointer(
      type: string,
      target: EventTarget,
      init: { pointerType?: string; y?: number },
    ) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: init.y ?? 10,
      })
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        pointerType: { value: init.pointerType ?? 'touch' },
      })
      target.dispatchEvent(event)
    }

    const gripOf = (name: string) =>
      [...document.querySelectorAll('main li, li')]
        .find((li) => li.textContent?.includes(name))!
        .querySelector('.touch-none')!
    const rowOf = (name: string) =>
      [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(name))!
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

    async function reorderView() {
      await seed('A')
      await seed('B')
      await seed('C')
      const w = await mountView()
      buttonByText('Reorder').click()
      await settle()
      return w
    }

    it('moves an account after the finger rests on the grip and slides', async () => {
      const w = await reorderView()
      pointer('pointerdown', gripOf('C'), { y: 100 })
      await wait(150) // past the hold
      under = rowOf('A')
      pointer('pointermove', window, { y: 20 })
      await settle()
      expect(rowOf('A').querySelector('[data-drag-item]')!.className).toContain(
        'border-(--p-primary-color)',
      )
      pointer('pointerup', window, { y: 20 })
      await settle()
      expect(listedNames(w)).toEqual(['C', 'A', 'B'])
    })

    it('ignores a quick tap on the grip', async () => {
      const w = await reorderView()
      under = rowOf('A')
      pointer('pointerdown', gripOf('C'), { y: 100 })
      pointer('pointerup', window, { y: 100 })
      await wait(150)
      await settle()
      expect(listedNames(w)).toEqual(['A', 'B', 'C'])
    })

    it('ignores a finger that slides off before the hold is over', async () => {
      const w = await reorderView()
      pointer('pointerdown', gripOf('C'), { y: 100 })
      under = rowOf('A')
      pointer('pointermove', window, { y: 60 }) // a swipe, within the hold
      await wait(150)
      pointer('pointerup', window, { y: 20 })
      await settle()
      expect(listedNames(w)).toEqual(['A', 'B', 'C'])
    })

    it('leaves the mouse to native drag and drop', async () => {
      const w = await reorderView()
      pointer('pointerdown', gripOf('C'), { y: 100, pointerType: 'mouse' })
      await wait(150)
      under = rowOf('A')
      pointer('pointermove', window, { y: 20, pointerType: 'mouse' })
      pointer('pointerup', window, { y: 20, pointerType: 'mouse' })
      await settle()
      expect(listedNames(w)).toEqual(['A', 'B', 'C'])
    })
  })

  describe('balances', () => {
    function accountIn(name: string, currency: string, grouping_id: UUID | null = null) {
      return accountsRepo.create({
        name,
        balance: zeroMoney(currency),
        tags: [],
        location_id: null,
        grouping_id,
        colour: '#3b82f6',
        icon: 'wallet',
      })
    }

    // Income: the transaction write refreshes the account's cached balance.
    function income(to: UUID, value: number, currency: string) {
      return transactionsRepo.create({
        account_id__from: null,
        account_id__to: to,
        amount__from: moneyAmount(value, 2, currency),
        amount__to: moneyAmount(value, 2, currency),
        transaction_at: localMoment('2026-10-01T12:00:00.000+02:00', 'Europe/Berlin'),
        date_override: null,
        tags: [],
        location_lat: null,
        location_lon: null,
        location_id: null,
      })
    }

    function eurRates(rates: Record<string, number>) {
      rateRows = [
        {
          id: 'r' as UUID,
          date: '2026-10-24',
          base_currency: 'EUR',
          rates,
          provider: 'test',
          created_at_utc: new Date(),
          updated_at_utc: new Date(),
          deleted_at_utc: null,
        },
      ]
    }

    const rowText = (w: VueWrapper, name: string) =>
      w
        .findAll('li')
        .find((li) => li.text().includes(name))!
        .text()

    it('shows each balance natively, and ≈ EUR for another currency', async () => {
      eurRates({ USD: 2 })
      const cash = await accountIn('Cash', 'EUR')
      const card = await accountIn('Card', 'USD')
      await income(cash.id, 1250, 'EUR')
      await income(card.id, 1000, 'USD')
      const w = await mountView()

      expect(rowText(w, 'Cash')).toContain(formatMoney(moneyAmount(1250, 2, 'EUR')))
      expect(rowText(w, 'Cash')).not.toContain('≈')
      expect(rowText(w, 'Card')).toContain(formatMoney(moneyAmount(1000, 2, 'USD')))
      expect(rowText(w, 'Card')).toContain(`≈ ${formatApprox({ value: 5, currency: 'EUR' })}`)
    })

    it('says when there is no rate to the base currency', async () => {
      await accountIn('Card', 'USD')
      const w = await mountView()
      expect(rowText(w, 'Card')).toContain('no USD → EUR rate')
    })

    it('totals a one-currency group natively, a mixed page in EUR only', async () => {
      eurRates({ USD: 2 })
      const trip = await groupingsRepo.create({ name: 'Trip', colour: '#000000', icon: 'car' })
      const a = await accountIn('Card A', 'USD', trip.id)
      const b = await accountIn('Card B', 'USD', trip.id)
      const cash = await accountIn('Cash', 'EUR')
      await income(a.id, 300, 'USD')
      await income(b.id, 100, 'USD')
      await income(cash.id, 1000, 'EUR')
      const w = await mountView()

      const header = w.find('section[aria-label="Trip"] > div').text()
      expect(header).toContain(formatMoney(moneyAmount(400, 2, 'USD')))
      expect(header).toContain(`≈ ${formatApprox({ value: 2, currency: 'EUR' })}`)

      const total = w.find('[aria-label="Total of all accounts"]').text()
      expect(total).not.toContain('$')
      expect(total).toContain(`≈ ${formatApprox({ value: 12, currency: 'EUR' })}`)
    })

    it('rebuilds stale balances with the page button and says so', async () => {
      const cash = await accountIn('Cash', 'EUR')
      await income(cash.id, 1250, 'EUR')
      await db.run('UPDATE accounts SET balance_value = 1 WHERE id = ?', [cash.id])
      const w = await mountView()
      expect(rowText(w, 'Cash')).toContain(formatMoney(moneyAmount(1, 2, 'EUR')))

      buttonByText('Recalculate balances').click()
      await settle()

      expect(rowText(w, 'Cash')).toContain(formatMoney(moneyAmount(1250, 2, 'EUR')))
      expect(w.text()).toContain('1 balance was off and is fixed now.')
    })

    it('shows the currency read-only, with the transaction count, once transactions use it', async () => {
      const cash = await accountIn('Cash', 'EUR')
      await income(cash.id, 1250, 'EUR')
      await income(cash.id, 500, 'EUR')
      const w = await mountView()
      await w.find('button[aria-label="Edit Cash"]').trigger('click')
      await settle()

      expect(document.getElementById('account-currency')).toBeNull() // no picker
      const shown = document.getElementById('account-currency-value')!.textContent!
      expect(shown).toContain('EUR')
      expect(shown).toContain('Euro')
      expect(shown).toContain('(2 transactions)')
      expect(document.body.textContent).not.toContain('Locked')
    })

    it('offers the currency picker on an account without transactions', async () => {
      await accountIn('Cash', 'EUR')
      const w = await mountView()
      await w.find('button[aria-label="Edit Cash"]').trigger('click')
      await settle()

      const currency = document.getElementById('account-currency') as HTMLInputElement
      expect(currency.disabled).toBe(false)
      expect(currency.value).toBe('EUR')
      expect(document.getElementById('account-currency-value')).toBeNull()
    })

    it('rebuilds one balance from the account dialog', async () => {
      const cash = await accountIn('Cash', 'EUR')
      await income(cash.id, 1250, 'EUR')
      await db.run('UPDATE accounts SET balance_value = 1 WHERE id = ?', [cash.id])
      const w = await mountView()
      await w.find('button[aria-label="Edit Cash"]').trigger('click')
      await settle()

      document.querySelector<HTMLButtonElement>('button[aria-label="Recalculate balance"]')!.click()
      await settle()

      expect(document.body.textContent).toContain(
        `The balance was off; it is ${formatMoney(moneyAmount(1250, 2, 'EUR'))} now.`,
      )
    })
  })
})
