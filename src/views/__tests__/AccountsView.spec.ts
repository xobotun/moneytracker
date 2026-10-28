import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import Dialog from 'primevue/dialog'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { AccountsRepository } from '@/db/repositories/AccountsRepository'
import { AccountGroupingsRepository } from '@/db/repositories/AccountGroupingsRepository'
import { TagsRepository } from '@/db/repositories/TagsRepository'
import { TagDetailsRepository } from '@/db/repositories/TagDetailsRepository'
import { TransactionsRepository } from '@/db/repositories/TransactionsRepository'
import { moneyAmount, zeroMoney } from '@/db/MoneyAmount'
import { localMoment } from '@/db/LocalMoment'
import { AppliedRatesRepository } from '@/db/repositories/AppliedRatesRepository'
import { ExchangeRatesRepository } from '@/db/repositories/ExchangeRatesRepository'
import { todayLocal } from '@/money/dates'
import type { ExchangeRateInput } from '@/money/providers'
import { RateService } from '@/money/rateService'
import { formatDay } from '@/format/date'
import { useAccountsStore } from '@/stores/accounts'
import { useTagsStore } from '@/stores/tags'
import { useMoneySettingsStore } from '@/stores/moneySettings'
import { useLayoutStore } from '@/stores/layout'
import type { ShortId } from '@/db/shortId'
import { formatApprox, formatMoney } from '@/format/currency'
import AccountsView from '../AccountsView.vue'

// Real store and repositories over an in-memory database; only the
// module-level repository registry is replaced.
let accountsRepo: AccountsRepository
let groupingsRepo: AccountGroupingsRepository
let appliedRepo: AppliedRatesRepository
let rateService: RateService
// What the fake rate source publishes; a function may throw (source down).
let sourceAnswers: ExchangeRateInput[] | (() => ExchangeRateInput[]) = []
let transactionsRepo: TransactionsRepository
let tagsRepo: TagsRepository
let detailsRepo: TagDetailsRepository
vi.mock('@/db/init', () => ({
  getAccountsRepository: () => accountsRepo,
  getAppliedRatesRepository: () => appliedRepo,
  getRateService: () => rateService,
  getAccountGroupingsRepository: () => groupingsRepo,
  getTransactionsRepository: () => transactionsRepo,
  getTagsRepository: () => tagsRepo,
  getTagDetailsRepository: () => detailsRepo,
}))

function seed(name: string) {
  return accountsRepo.create({
    name,
    balance: zeroMoney('EUR'),
    tags: [],
    location_id: null,
    grouping_id: null,
    colour: '#3b82f6',
    icon: primeIcon('wallet'),
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
    // The icon dialog's tab list watches its size; jsdom has no ResizeObserver.
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
    sourceAnswers = []
    pinia = createPinia()
    setActivePinia(pinia)
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    accountsRepo = new AccountsRepository(db)
    groupingsRepo = new AccountGroupingsRepository(db)
    transactionsRepo = new TransactionsRepository(db)
    tagsRepo = new TagsRepository(db)
    detailsRepo = new TagDetailsRepository(db)
    appliedRepo = new AppliedRatesRepository(db)
    rateService = new RateService({
      exchangeRates: new ExchangeRatesRepository(db),
      appliedRates: appliedRepo,
      providers: [
        {
          id: 'source',
          priority: 20,
          fetchDay: async () =>
            typeof sourceAnswers === 'function' ? sourceAnswers() : sourceAnswers,
        },
      ],
      today: () => todayLocal(),
    })
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

  /** The tag chips on the page: label (without the screen-reader prefix), icon classes, archived. */
  const tagChips = () =>
    [...document.querySelectorAll<HTMLElement>('[data-tag-chip]')].map((chip) => ({
      label: chip.lastElementChild?.textContent?.trim(),
      icon: chip.querySelector('[data-face]')?.className ?? '',
      archived: chip.hasAttribute('data-archived'),
    }))

  it('shows a renamed tag on the account', async () => {
    const tag = await tagsRepo.create({ kind: 'tag', name: 'daily' })
    const account = await seed('Cash')
    await accountsRepo.update(account.id, { tags: [tag.id] })
    await mountView()
    expect(tagChips().map((c) => c.label)).toEqual(['daily'])

    await tagsRepo.update(tag.id, { name: 'everyday' })
    await useAccountsStore().load()
    await useTagsStore().load()
    await settle()
    expect(tagChips().map((c) => c.label)).toEqual(['everyday'])
  })

  it('shows the tags as chips with their icon, a nested one by its path, archived ones faint', async () => {
    const family = await tagsRepo.create({
      kind: 'tag',
      name: 'family',
      colour: '#ef4444',
      icon: primeIcon('heart'),
    })
    const mia = await tagsRepo.create({ kind: 'tag', name: 'mia', parent_id: family.id })
    const old = await tagsRepo.create({ kind: 'tag', name: 'old', icon: primeIcon('clock') })
    const gone = await tagsRepo.create({ kind: 'tag', name: 'gone' })
    const account = await seed('Cash')
    await accountsRepo.update(account.id, { tags: [mia.id, gone.id, old.id] })
    await tagsRepo.archive(old.id)
    await tagsRepo.softDelete(gone.id)
    const w = await mountView()

    const chips = tagChips()
    expect(chips.map(({ label, archived }) => [label, archived])).toEqual([
      ['family › mia', false],
      ['old', true],
    ])
    expect(chips[0]!.icon).toContain('pi-heart') // inherited from family
    expect(chips[1]!.icon).toContain('pi-clock')
    expect(w.find('[data-tag-chip][data-archived]').classes()).toContain('opacity-60')
    expect(w.text()).not.toContain('gone')
    expect(w.text()).not.toContain('#')
  })

  it('shows the tags next to the group chip when shown by currency', async () => {
    const home = await groupingsRepo.create({
      name: 'Home',
      colour: '#16a34a',
      icon: primeIcon('home'),
    })
    const tag = await tagsRepo.create({ kind: 'tag', name: 'daily', icon: primeIcon('sun') })
    const account = await seed('Cash')
    await accountsRepo.update(account.id, { grouping_id: home.id, tags: [tag.id] })
    const w = await mountView()
    await w.find('button[aria-label="Show accounts by currency"]').trigger('click')
    await settle()

    expect(w.find('[data-currency-block]').exists()).toBe(true)
    expect(tagChips()).toEqual([
      { label: 'daily', icon: expect.stringContaining('pi-sun'), archived: false },
    ])
    // The group stays apart: an outlined chip, before the tags.
    const group = w.find('[data-group-chip]')
    expect(group.text()).toContain('Home')
    expect(group.classes()).toContain('ring-1')
    expect(w.find('[data-tag-chip]').classes()).not.toContain('ring-1')
  })

  it('saves tags typed in the editor as plain tags', async () => {
    const existing = await tagsRepo.create({ kind: 'tag', name: 'daily' })
    const account = await seed('Cash')
    const w = await mountView()
    ;[...w.findAll('button')].find((b) => b.text().includes('Edit'))!.element.click()
    await settle()
    const input = document.getElementById('account-tags') as HTMLInputElement
    input.value = 'Daily'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
    )
    await settle()
    buttonByText('Save').click()
    await settle()
    expect((await accountsRepo.findById(account.id))!.tags).toEqual([existing.id])
    expect(await tagsRepo.listAll()).toHaveLength(1)
  })

  it('keeps a nested tag when the account is saved', async () => {
    // A top-level namesake that is clearly older: a lookup by name alone would pick it.
    const at = '2020-01-01T00:00:00.000Z'
    await db.run(
      `INSERT INTO tags (id, kind, name, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES ('miaTop000001', 'tag', 'mia', ?, ?, ?)`,
      [at, at, at],
    )
    const family = await tagsRepo.create({ kind: 'tag', name: 'family' })
    const mia = await tagsRepo.create({ kind: 'tag', name: 'mia', parent_id: family.id })
    const account = await seed('Cash')
    await accountsRepo.update(account.id, { tags: [mia.id] })
    await mountView()
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Edit'))!.click()
    await settle()
    buttonByText('Save').click()
    await settle()
    expect((await accountsRepo.findById(account.id))!.tags).toEqual([mia.id])
    expect(await tagsRepo.listAll()).toHaveLength(3)
  })

  describe('tags in the dialog', () => {
    const tagsInput = () => document.getElementById('account-tags') as HTMLInputElement
    async function typeTag(text: string) {
      tagsInput().value = text
      tagsInput().dispatchEvent(new Event('input'))
      // AutoComplete waits 300 ms after typing before it searches.
      await new Promise((r) => setTimeout(r, 400))
      await settle()
    }
    /** The tags field's suggestions (the currency field has a list of its own). */
    const suggestions = () => {
      const list = document.getElementById(tagsInput().getAttribute('aria-controls') ?? '')
      return list ? [...list.querySelectorAll<HTMLElement>('[role=option]')] : []
    }
    const chipsInField = () =>
      [
        ...tagsInput().closest('.p-autocomplete')!.querySelectorAll('.p-autocomplete-chip-item'),
      ].map((item) => ({
        text: item.textContent?.trim(),
        icon: item.querySelector('[data-chip-icon]')?.className ?? null,
      }))
    async function editFirstAccount() {
      ;[...document.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Edit'))!
        .click()
      await settle()
    }

    it('suggests live, active plain tags by a name or another name, by path with their icon', async () => {
      const family = await tagsRepo.create({
        kind: 'tag',
        name: 'family',
        icon: primeIcon('heart'),
        colour: '#ef4444',
      })
      await tagsRepo.create({ kind: 'tag', name: 'mia', parent_id: family.id })
      await tagsRepo.create({ kind: 'tag', name: 'kids', synonyms: ['Mimi'] })
      const old = await tagsRepo.create({ kind: 'tag', name: 'milan' })
      await tagsRepo.archive(old.id)
      await tagsRepo.create({ kind: 'category', name: 'Milk' })
      await seed('Cash')
      await mountView()
      await editFirstAccount()

      await typeTag('MI')
      expect(suggestions().map((o) => o.textContent?.trim())).toEqual([
        'family',
        'family › mia',
        'kids', // by its other name, Mimi
      ])
      expect(suggestions()[1]!.querySelector('.pi-heart')).not.toBeNull()
    })

    it('adds a picked tag and saves that very tag, with no new one', async () => {
      // A top-level namesake that is clearly older: a lookup by name alone would pick it.
      const at = '2020-01-01T00:00:00.000Z'
      await db.run(
        `INSERT INTO tags (id, kind, name, moved_at_utc, created_at_utc, updated_at_utc)
         VALUES ('miaTop000001', 'tag', 'mia', ?, ?, ?)`,
        [at, at, at],
      )
      const family = await tagsRepo.create({
        kind: 'tag',
        name: 'family',
        icon: primeIcon('heart'),
      })
      const mia = await tagsRepo.create({ kind: 'tag', name: 'mia', parent_id: family.id })
      const account = await seed('Cash')
      await mountView()
      await editFirstAccount()

      await typeTag('mi')
      suggestions()
        .find((o) => o.textContent?.trim() === 'family › mia')!
        .click()
      await settle()
      // A new name typed next to it stays plain.
      await typeTag('brand new')
      tagsInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
      )
      await settle()
      expect(chipsInField()).toEqual([
        { text: 'mia', icon: expect.stringContaining('pi-heart') },
        { text: 'brand new', icon: null },
      ])

      buttonByText('Save').click()
      await settle()
      const saved = (await accountsRepo.findById(account.id))!.tags
      expect(saved[0]).toBe(mia.id)
      expect(saved).toHaveLength(2)
      const created = (await tagsRepo.listAll()).find((t) => t.id === saved[1])!
      expect(created).toMatchObject({ name: 'brand new', kind: 'tag', parent_id: null })
      expect(await tagsRepo.listAll()).toHaveLength(4) // mia, mia, family, brand new
    })

    it('saves a name left typed without Enter', async () => {
      const daily = await tagsRepo.create({ kind: 'tag', name: 'daily' })
      const account = await seed('Cash')
      await accountsRepo.update(account.id, { tags: [daily.id] })
      await mountView()
      await editFirstAccount()
      expect(chipsInField().map((c) => c.text)).toEqual(['daily'])

      tagsInput().value = 'groceries'
      tagsInput().dispatchEvent(new Event('input'))
      buttonByText('Save').click()
      await settle()
      const saved = (await accountsRepo.findById(account.id))!.tags
      expect(saved[0]).toBe(daily.id)
      expect((await tagsRepo.findById(saved[1]!))?.name).toBe('groceries')
    })
  })

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

  it('marks an account as cash in the editor', async () => {
    await seed('Wallet')
    const w = await mountView()
    await w.find('button[aria-label="Edit Wallet"]').trigger('click')
    await settle()

    const cash = document.getElementById('account-is-cash') as HTMLInputElement
    expect(cash.checked).toBe(false)
    cash.click()
    await settle()
    buttonByText('Save').click()
    await settle()

    const [saved] = await accountsRepo.list()
    expect(saved!.is_cash).toBe(true)
    await w.find('button[aria-label="Edit Wallet"]').trigger('click')
    await settle()
    expect((document.getElementById('account-is-cash') as HTMLInputElement).checked).toBe(true)
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
    const results = [...document.querySelectorAll('[role=group][aria-label="PrimeIcons"] button')]
    expect(results.map((b) => b.getAttribute('aria-label'))).toEqual(['euro'])
    ;(results[0] as HTMLButtonElement).click()
    await settle()

    // The trigger now shows the picked icon, since it is not a quick one.
    expect(document.querySelector('button[aria-label="All icons, selected: euro"]')).not.toBeNull()
    buttonByText('Save').click()
    await settle()
    expect((await accountsRepo.list())[0]!.icon).toEqual(primeIcon('euro'))
  })

  it('keeps the account dialog open on Escape while the icon dialog is on top', async () => {
    await seed('Cash')
    const w = await mountView()
    await w.find('button[aria-label="Edit Cash"]').trigger('click')
    await settle()
    // Every open dialog hears Escape; only the top one may act on it.
    const accountDialog = () =>
      w.findAllComponents(Dialog).find((d) => d.props('header') === 'Edit account')!
    expect(accountDialog().props('closeOnEscape')).toBe(true)

    document.querySelector<HTMLButtonElement>('button[aria-label="All icons"]')!.click()
    await settle()
    expect(document.body.textContent).toContain('Choose an icon')
    expect(accountDialog().props('closeOnEscape')).toBe(false)

    document.querySelector<HTMLButtonElement>('button[aria-label="euro"]')!.click()
    await settle()
    expect(document.body.textContent).not.toContain('Choose an icon')
    expect(accountDialog().props('closeOnEscape')).toBe(true)
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
      const trip = await groupingsRepo.create({
        name: 'Trip',
        colour: '#000000',
        icon: primeIcon('car'),
      })
      await accountsRepo.create({
        name: 'Card',
        balance: zeroMoney('EUR'),
        tags: [],
        location_id: null,
        grouping_id: trip.id,
        colour: '#3b82f6',
        icon: primeIcon('credit-card'),
      })
      await seed('Cash')
      const w = await mountView()
      expect(layout(w)).toEqual({ Trip: ['Card'], 'Accounts in no group': ['Cash'] })
      expect(w.find('[aria-label="Edit group Trip"]').exists()).toBe(false)
      expect(w.find('[aria-label="Move group Trip up"]').exists()).toBe(false)
    })

    it('reorders groups with their arrows', async () => {
      await groupingsRepo.create({ name: 'Trip', colour: '#000000', icon: primeIcon('car') })
      await groupingsRepo.create({ name: 'Home', colour: '#000000', icon: primeIcon('home') })
      const w = await mountView()
      buttonByText('Reorder').click()
      await settle()
      await w.find('[aria-label="Move group Home up"]').trigger('click')
      await settle()
      expect((await groupingsRepo.list()).map((g) => g.name)).toEqual(['Home', 'Trip'])
      expect(Object.keys(layout(w))).toEqual(['Home', 'Trip', 'Accounts in no group'])
    })

    it('deletes a group and keeps its accounts below the groups', async () => {
      const trip = await groupingsRepo.create({
        name: 'Trip',
        colour: '#000000',
        icon: primeIcon('car'),
      })
      await accountsRepo.create({
        name: 'Card',
        balance: zeroMoney('EUR'),
        tags: [],
        location_id: null,
        grouping_id: trip.id,
        colour: '#3b82f6',
        icon: primeIcon('credit-card'),
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
    function accountIn(
      name: string,
      currency: string,
      grouping_id: ShortId | null = null,
      is_cash = false,
    ) {
      return accountsRepo.create({
        name,
        balance: zeroMoney(currency),
        is_cash,
        tags: [],
        location_id: null,
        grouping_id,
        colour: '#3b82f6',
        icon: primeIcon('wallet'),
      })
    }

    let salary: ShortId // every transaction needs a category
    beforeEach(async () => {
      salary = (await new TagsRepository(db).create({ kind: 'category', name: 'Salary' })).id
    })

    // Income: the transaction write refreshes the account's cached balance.
    function income(to: ShortId, value: number, currency: string) {
      const amount = moneyAmount(value, 2, currency)
      return transactionsRepo.create({
        account_id__from: null,
        account_id__to: to,
        amount__from: amount,
        amount__to: amount,
        transaction_at: localMoment('2026-10-01T12:00:00.000+02:00', 'Europe/Berlin'),
        date_override: null,
        tags: [],
        categories: [{ category_id: salary, amount__from: amount, amount__to: amount }],
        location_lat: null,
        location_lon: null,
        location_id: null,
      })
    }

    /** Today's applied rates EUR → each code, as if resolved earlier. */
    async function eurRates(rates: Record<string, number>) {
      const today = todayLocal()
      for (const [code, rate] of Object.entries(rates)) {
        await appliedRepo.saveAuto({
          date: today,
          x: 'EUR',
          y: code,
          resolution: { rate, provider: 'test', via: null, referenceDate: today },
        })
      }
    }

    /** Mounts and waits for the background rate work and its re-render. */
    async function mountSettled() {
      const w = await mountView()
      await settle()
      return w
    }

    const rowText = (w: VueWrapper, name: string) =>
      w
        .findAll('li')
        .find((li) => li.text().includes(name))!
        .text()

    it('shows each balance natively, and ≈ EUR for another currency', async () => {
      await eurRates({ USD: 2 })
      const cash = await accountIn('Cash', 'EUR')
      const card = await accountIn('Card', 'USD')
      await income(cash.id, 1250, 'EUR')
      await income(card.id, 1000, 'USD')
      const w = await mountSettled()

      expect(rowText(w, 'Cash')).toContain(formatMoney(moneyAmount(1250, 2, 'EUR')))
      expect(rowText(w, 'Cash')).not.toContain('≈')
      expect(rowText(w, 'Card')).toContain(formatMoney(moneyAmount(1000, 2, 'USD')))
      expect(rowText(w, 'Card')).toContain(`≈ ${formatApprox({ value: 5, currency: 'EUR' })}`)
    })

    it('says when there is no rate to the base currency', async () => {
      await accountIn('Card', 'USD')
      const w = await mountSettled()
      expect(rowText(w, 'Card')).toContain('no USD → EUR rate')
    })

    it('totals a one-currency group natively, a mixed page in EUR only', async () => {
      await eurRates({ USD: 2 })
      const trip = await groupingsRepo.create({
        name: 'Trip',
        colour: '#000000',
        icon: primeIcon('car'),
      })
      const a = await accountIn('Card A', 'USD', trip.id)
      const b = await accountIn('Card B', 'USD', trip.id)
      const cash = await accountIn('Cash', 'EUR')
      await income(a.id, 300, 'USD')
      await income(b.id, 100, 'USD')
      await income(cash.id, 1000, 'EUR')
      const w = await mountSettled()

      const header = w.find('section[aria-label="Trip"] > div').text()
      expect(header).toContain(formatMoney(moneyAmount(400, 2, 'USD')))
      expect(header).toContain(`≈ ${formatApprox({ value: 2, currency: 'EUR' })}`)

      const total = w.find('[aria-label="Total of all accounts"]').text()
      expect(total).not.toContain('$')
      expect(total).toContain(`≈ ${formatApprox({ value: 12, currency: 'EUR' })}`)
    })

    it('shows a partial total as a bound, naming the currencies without a rate', async () => {
      await eurRates({ USD: 2 })
      const cash = await accountIn('Cash', 'EUR')
      const dubai = await accountIn('Dubai', 'AED')
      await income(cash.id, 1000, 'EUR')
      await income(dubai.id, 500, 'AED')
      const w = await mountSettled()

      const total = w.find('[aria-label="Total of all accounts"]').text()
      expect(total).toContain(`≥ ${formatApprox({ value: 10, currency: 'EUR' })}`)
      expect(total).toContain('no AED → EUR rate')
    })

    const published = (rates: Record<string, number>): ExchangeRateInput[] => [
      { date: todayLocal(), base_currency: 'EUR', provider: 'source', rates },
    ]

    it('fetches a missing rate in the background and then shows it', async () => {
      sourceAnswers = published({ USD: 2 })
      const card = await accountIn('Card', 'USD')
      await income(card.id, 1000, 'USD')
      const w = await mountView()

      await vi.waitFor(() =>
        expect(rowText(w, 'Card')).toContain(`≈ ${formatApprox({ value: 5, currency: 'EUR' })}`),
      )
    })

    it('resolves new pairs when the base currency changes', async () => {
      sourceAnswers = published({ USD: 2 })
      const cash = await accountIn('Cash', 'EUR')
      await income(cash.id, 1250, 'EUR')
      const w = await mountSettled()
      expect(rowText(w, 'Cash')).not.toContain('≈')

      useMoneySettingsStore(pinia).baseCurrency = 'USD'

      await vi.waitFor(() =>
        expect(rowText(w, 'Cash')).toContain(`≈ ${formatApprox({ value: 25, currency: 'USD' })}`),
      )
    })

    it('refreshes the rates with the page button and says how new they are', async () => {
      sourceAnswers = published({ USD: 2 })
      await accountIn('Card', 'USD')
      const w = await mountSettled()

      buttonByText('Refresh rates').click()

      await vi.waitFor(() =>
        expect(w.text()).toContain(
          `Rates refreshed: the newest are from ${formatDay(todayLocal())}.`,
        ),
      )
    })

    it('refresh failure is reported', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      sourceAnswers = () => {
        throw new TypeError('Failed to fetch')
      }
      await accountIn('Card', 'USD')
      const w = await mountSettled()

      buttonByText('Refresh rates').click()

      await vi.waitFor(() =>
        expect(w.text()).toContain(
          'Could not refresh the rates. None of the rate sources answered.',
        ),
      )
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

    describe('archived accounts', () => {
      const archivedSection = (w: VueWrapper) => w.find('section[aria-label="Archived accounts"]')
      const disclosure = (w: VueWrapper) => archivedSection(w).find('button[aria-expanded]')
      const listedIn = (w: VueWrapper, label: string) =>
        w
          .find(`section[aria-label="${label}"]`)
          .findAll('li .font-medium')
          .map((n) => n.text())

      it('are listed apart, collapsed, out of the page and group totals, with their own', async () => {
        const trip = await groupingsRepo.create({
          name: 'Trip',
          colour: '#000000',
          icon: primeIcon('car'),
        })
        const card = await accountIn('Card', 'EUR', trip.id)
        const old = await accountIn('Old card', 'EUR', trip.id)
        const cash = await accountIn('Cash', 'EUR')
        const wallet = await accountIn('Wallet', 'EUR')
        await income(card.id, 1000, 'EUR')
        await income(old.id, 300, 'EUR')
        await income(cash.id, 200, 'EUR')
        await income(wallet.id, 50, 'EUR')
        await accountsRepo.archive(old.id)
        await accountsRepo.archive(wallet.id)
        const w = await mountSettled()

        expect(listedIn(w, 'Trip')).toEqual(['Card'])
        expect(listedIn(w, 'Accounts in no group')).toEqual(['Cash'])
        const header = w.find('section[aria-label="Trip"] > div').text()
        expect(header).toContain(formatMoney(moneyAmount(1000, 2, 'EUR')))
        const total = w.find('[aria-label="Total of all accounts"]').text()
        expect(total).toContain(formatMoney(moneyAmount(1200, 2, 'EUR')))

        // Collapsed, with its count and total.
        expect(disclosure(w).text()).toBe('Archived accounts (2)')
        expect(disclosure(w).attributes('aria-expanded')).toBe('false')
        expect(listedIn(w, 'Archived accounts')).toEqual([])
        expect(archivedSection(w).find('[data-archived-total]').text()).toContain(
          formatMoney(moneyAmount(350, 2, 'EUR')),
        )

        await disclosure(w).trigger('click')
        await settle()
        expect(disclosure(w).attributes('aria-expanded')).toBe('true')
        expect(listedIn(w, 'Archived accounts')).toEqual(['Old card', 'Wallet'])
        expect(rowText(w, 'Old card')).toContain(formatMoney(moneyAmount(300, 2, 'EUR')))
        expect(rowText(w, 'Wallet')).toContain(formatMoney(moneyAmount(50, 2, 'EUR')))
      })

      it('are left out of reorder mode', async () => {
        const old = await accountIn('Old card', 'EUR')
        await accountIn('Cash', 'EUR')
        await accountsRepo.archive(old.id)
        const w = await mountSettled()
        expect(archivedSection(w).exists()).toBe(true)
        buttonByText('Reorder').click()
        await settle()
        expect(archivedSection(w).exists()).toBe(false)
        expect(w.find('[aria-label="Move Old card up"]').exists()).toBe(false)
      })

      async function openEdit(w: VueWrapper, name: string) {
        await w.find(`button[aria-label="Edit ${name}"]`).trigger('click')
        await settle()
      }
      const dialogButton = (label: string) =>
        document.querySelector<HTMLButtonElement>(`.p-dialog button[aria-label="${label}"]`)

      it('archives an empty account from its dialog at once', async () => {
        const cash = await accountIn('Cash', 'EUR')
        const w = await mountSettled()
        await openEdit(w, 'Cash')
        const archive = dialogButton('Archive Cash')!
        expect(archive.textContent?.trim()).toBe('Archive')
        archive.click()
        await settle()
        expect(document.querySelector('.p-dialog')).toBeNull()
        expect((await accountsRepo.findById(cash.id))!.archived_at_utc).not.toBeNull()
        expect(disclosure(w).text()).toBe('Archived accounts (1)')
      })

      it('asks before archiving an account that still holds money', async () => {
        const cash = await accountIn('Cash', 'EUR')
        await income(cash.id, 1250, 'EUR')
        const w = await mountSettled()
        await openEdit(w, 'Cash')
        dialogButton('Archive Cash')!.click()
        await settle()
        const alert = document.querySelector('.p-dialog [role=alert]')!
        expect(alert.textContent).toContain(
          `It still holds ${formatMoney(moneyAmount(1250, 2, 'EUR'))}. Archive it anyway?`,
        )
        expect((await accountsRepo.findById(cash.id))!.archived_at_utc).toBeNull()

        buttonByText('Keep it').click()
        await settle()
        expect(document.querySelector('.p-dialog [role=alert]')).toBeNull()
        dialogButton('Archive Cash')!.click()
        await settle()
        buttonByText('Archive account').click()
        await settle()
        expect(document.querySelector('.p-dialog')).toBeNull()
        expect((await accountsRepo.findById(cash.id))!.archived_at_utc).not.toBeNull()
      })

      it('unarchives from the dialog, back into its group', async () => {
        const trip = await groupingsRepo.create({
          name: 'Trip',
          colour: '#000000',
          icon: primeIcon('car'),
        })
        const card = await accountIn('Card', 'EUR', trip.id)
        await accountsRepo.archive(card.id)
        const w = await mountSettled()
        expect(listedIn(w, 'Trip')).toEqual([])
        await disclosure(w).trigger('click')
        await settle()
        await openEdit(w, 'Card')
        expect(dialogButton('Archive Card')).toBeNull()
        dialogButton('Unarchive Card')!.click()
        await settle()
        expect(listedIn(w, 'Trip')).toEqual(['Card'])
        expect(archivedSection(w).exists()).toBe(false)
      })
    })

    describe('hidden amounts', () => {
      const HIDDEN = 'button[aria-label="Amount hidden, show it"]'
      const row = (w: VueWrapper, name: string) =>
        w.findAll('li').find((li) => li.find('.font-medium').text() === name)!

      // Trip: a 10 USD card (≈ €5); no group: €12.50 cash; archived: €3.
      async function seedMixed() {
        await eurRates({ USD: 2 })
        const trip = await groupingsRepo.create({
          name: 'Trip',
          colour: '#000000',
          icon: primeIcon('car'),
        })
        const card = await accountIn('Card', 'USD', trip.id)
        const cash = await accountIn('Cash', 'EUR')
        const old = await accountIn('Old card', 'EUR')
        await income(card.id, 1000, 'USD')
        await income(cash.id, 1250, 'EUR')
        await income(old.id, 300, 'EUR')
        await accountsRepo.archive(old.id)
      }
      const values = () => [
        formatMoney(moneyAmount(1000, 2, 'USD')),
        formatApprox({ value: 5, currency: 'EUR' }),
        formatMoney(moneyAmount(1250, 2, 'EUR')),
        formatApprox({ value: 17.5, currency: 'EUR' }),
        formatMoney(moneyAmount(300, 2, 'EUR')),
      ]

      it('shows a placeholder for every amount on the page and none of the values', async () => {
        await seedMixed()
        useLayoutStore(pinia).hideAmounts = true
        const w = await mountSettled()
        await w
          .find('section[aria-label="Archived accounts"] button[aria-expanded]')
          .trigger('click')
        await settle()

        const html = document.body.innerHTML
        for (const value of values()) expect(html).not.toContain(value)
        expect(html).not.toMatch(/[€$]/)
        expect(row(w, 'Card').findAll(HIDDEN)).toHaveLength(2) // the balance and ≈ EUR
        expect(row(w, 'Cash').findAll(HIDDEN)).toHaveLength(1)
        expect(row(w, 'Old card').findAll(HIDDEN)).toHaveLength(1)
        expect(w.find('section[aria-label="Trip"] > div').findAll(HIDDEN)).toHaveLength(2)
        expect(w.find('[aria-label="Total of all accounts"]').findAll(HIDDEN)).toHaveLength(1)
        expect(w.find('[data-archived-total]').findAll(HIDDEN)).toHaveLength(1)
      })

      it('shows one amount when its placeholder is pressed, until the page is left', async () => {
        await seedMixed()
        useLayoutStore(pinia).hideAmounts = true
        let w = await mountSettled()

        await row(w, 'Cash').find(HIDDEN).trigger('click')

        expect(row(w, 'Cash').text()).toContain(formatMoney(moneyAmount(1250, 2, 'EUR')))
        expect(row(w, 'Cash').find(HIDDEN).exists()).toBe(false)
        expect(row(w, 'Card').findAll(HIDDEN)).toHaveLength(2)
        expect(w.find('[aria-label="Total of all accounts"]').find(HIDDEN).exists()).toBe(true)

        wrapper!.unmount()
        w = await mountSettled()
        expect(row(w, 'Cash').find(HIDDEN).exists()).toBe(true)
        expect(document.body.innerHTML).not.toContain(formatMoney(moneyAmount(1250, 2, 'EUR')))
      })

      it('hides the amounts in the account dialog too', async () => {
        await seedMixed()
        useLayoutStore(pinia).hideAmounts = true
        const w = await mountSettled()
        await w.find('button[aria-label="Edit Cash"]').trigger('click')
        await settle()
        const dialog = () => document.querySelector('.p-dialog')!
        const shown = formatMoney(moneyAmount(1250, 2, 'EUR'))

        dialog()
          .querySelector<HTMLButtonElement>('button[aria-label="Recalculate balance"]')!
          .click()
        await settle()
        expect(dialog().textContent).toContain('The balance was already right: •••.')
        dialog().querySelector<HTMLButtonElement>('button[aria-label="Archive Cash"]')!.click()
        await settle()
        // The archive question (the recalculation message is an alert too).
        const question = () =>
          [...dialog().querySelectorAll('[role=alert]')].find((a) =>
            a.textContent?.includes('It still holds'),
          )!
        expect(question().textContent).toContain('It still holds •••. Archive it anyway?')
        expect(dialog().innerHTML).not.toContain(shown)

        question().querySelector<HTMLButtonElement>(HIDDEN)!.click()
        await settle()
        expect(question().textContent).toContain(`It still holds ${shown}.`)
        expect(document.querySelector('.p-dialog')).not.toBeNull() // pressing it did not submit
      })
    })

    describe('show by currency', () => {
      const toggle = (w: VueWrapper) => w.find('button[aria-label="Show accounts by currency"]')
      const hasButton = (text: string) =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === text)
      const namesIn = (w: VueWrapper, selector: string) =>
        w
          .find(selector)
          .findAll('li .font-medium')
          .map((n) => n.text())
      const kindTotal = (w: VueWrapper, label: string) =>
        w.find(`[role=group][aria-label="${label}"] [data-kind-total]`).text()

      // EUR: Home's card €10 and wallet €2.50 (cash), €0.50 coins (cash, no
      // group). USD: Trip's $40 cash and $6 card. Archived: a €3 card.
      async function seedCurrencies() {
        await eurRates({ USD: 2 })
        const home = await groupingsRepo.create({
          name: 'Home',
          colour: '#16a34a',
          icon: primeIcon('home'),
        })
        const trip = await groupingsRepo.create({
          name: 'Trip',
          colour: '#000000',
          icon: primeIcon('car'),
        })
        const accounts = [
          [await accountIn('Main card', 'EUR', home.id), 1000],
          [await accountIn('Wallet', 'EUR', home.id, true), 250],
          [await accountIn('Coins', 'EUR', null, true), 50],
          [await accountIn('Travel cash', 'USD', trip.id, true), 4000],
          [await accountIn('Dollar card', 'USD', trip.id), 600],
          [await accountIn('Old card', 'EUR'), 300],
        ] as const
        for (const [account, value] of accounts) {
          await income(account.id, value, account.balance.currency)
        }
        await accountsRepo.archive(accounts[5][0].id)
      }

      it('regroups the active accounts by currency, then cash and bank, with subtotals', async () => {
        await seedCurrencies()
        const w = await mountSettled()
        const pageTotal = w.find('[aria-label="Total of all accounts"]').text()
        expect(toggle(w).attributes('aria-pressed')).toBe('false')
        expect(toggle(w).text()).toBe('Show by currency')

        await toggle(w).trigger('click')

        expect(toggle(w).attributes('aria-pressed')).toBe('true')
        expect(w.find('section[aria-label="Home"]').exists()).toBe(false)
        expect(w.findAll('[data-currency-block]').map((b) => b.attributes('aria-label'))).toEqual([
          'Accounts in EUR',
          'Accounts in USD',
        ])
        expect(namesIn(w, '[aria-label="Cash in EUR"]')).toEqual(['Wallet', 'Coins'])
        expect(namesIn(w, '[aria-label="Bank in EUR"]')).toEqual(['Main card'])
        expect(namesIn(w, '[aria-label="Cash in USD"]')).toEqual(['Travel cash'])
        expect(namesIn(w, '[aria-label="Bank in USD"]')).toEqual(['Dollar card'])
        expect(kindTotal(w, 'Cash in EUR')).toBe(formatMoney(moneyAmount(300, 2, 'EUR')))
        expect(kindTotal(w, 'Bank in EUR')).toBe(formatMoney(moneyAmount(1000, 2, 'EUR')))
        expect(kindTotal(w, 'Cash in USD')).toBe(formatMoney(moneyAmount(4000, 2, 'USD')))
        expect(kindTotal(w, 'Bank in USD')).toBe(formatMoney(moneyAmount(600, 2, 'USD')))

        const eurTotal = w.find('[aria-label="Accounts in EUR"] [data-currency-total]').text()
        expect(eurTotal).toBe(formatMoney(moneyAmount(1300, 2, 'EUR')))
        const usdTotal = w.find('[aria-label="Accounts in USD"] [data-currency-total]').text()
        expect(usdTotal).toContain(formatMoney(moneyAmount(4600, 2, 'USD')))
        expect(usdTotal).toContain(`≈ ${formatApprox({ value: 23, currency: 'EUR' })}`)

        // Each row keeps its group as a chip; the page total and the archived
        // section stay as they are.
        expect(rowText(w, 'Wallet')).toContain('Home')
        expect(rowText(w, 'Travel cash')).toContain('Trip')
        const coins = w.findAll('li').find((li) => li.text().includes('Coins'))!
        expect(coins.find('[data-group-chip]').exists()).toBe(false)
        expect(w.find('[aria-label="Total of all accounts"]').text()).toBe(pageTotal)
        expect(pageTotal).toContain(`≈ ${formatApprox({ value: 36, currency: 'EUR' })}`)
        expect(w.find('[data-archived-total]').text()).toContain(
          formatMoney(moneyAmount(300, 2, 'EUR')),
        )

        await toggle(w).trigger('click')
        expect(w.find('[data-currency-block]').exists()).toBe(false)
        expect(w.find('section[aria-label="Home"]').exists()).toBe(true)
      })

      it('keeps reorder mode and itself apart', async () => {
        await seedCurrencies()
        const w = await mountSettled()
        await toggle(w).trigger('click')
        expect(hasButton('Reorder')).toBe(false)

        await toggle(w).trigger('click')
        buttonByText('Reorder').click()
        await settle()
        expect(toggle(w).exists()).toBe(false)
      })

      it('is kept nowhere: the page starts grouped again', async () => {
        await seedCurrencies()
        let w = await mountSettled()
        await toggle(w).trigger('click')
        expect(w.find('[data-currency-block]').exists()).toBe(true)

        wrapper!.unmount()
        w = await mountSettled()
        expect(toggle(w).attributes('aria-pressed')).toBe('false')
        expect(w.find('[data-currency-block]').exists()).toBe(false)
        expect(w.find('section[aria-label="Home"]').exists()).toBe(true)
      })

      it('opens an account from its row', async () => {
        await seedCurrencies()
        const w = await mountSettled()
        await toggle(w).trigger('click')
        await w.find('button[aria-label="Edit Wallet"]').trigger('click')
        await settle()
        expect((document.getElementById('account-name') as HTMLInputElement).value).toBe('Wallet')
      })
    })
  })
})
