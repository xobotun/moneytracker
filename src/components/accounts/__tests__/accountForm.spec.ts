import { describe, it, expect } from 'vitest'
import { moneyAmount } from '@/db/MoneyAmount'
import { asUuid } from '@/db/uuid'
import type { Account } from '@/db/types'
import {
  ACCOUNT_COLOURS,
  createInputFromDraft,
  currencySuggestions,
  draftFromAccount,
  iconColourOn,
  newAccountDraft,
  normaliseDraft,
  patchFromDraft,
  validateDraft,
  accountIconClass,
} from '../accountForm'

function account(over: Partial<Account> = {}): Account {
  return {
    id: asUuid('0190a000-0000-7000-8000-000000000001'),
    name: 'Cash',
    balance: moneyAmount(0, 2, 'EUR'),
    tags: ['daily'],
    location_id: null,
    colour: '#22c55e',
    icon: 'wallet',
    sort_order: 0,
    created_at_utc: new Date('2026-10-01T00:00:00Z'),
    updated_at_utc: new Date('2026-10-01T00:00:00Z'),
    deleted_at_utc: null,
    ...over,
  }
}

describe('newAccountDraft', () => {
  it('starts empty with the most used currency and the next palette colour', () => {
    const existing = [
      account({ balance: moneyAmount(0, 2, 'USD') }),
      account({ balance: moneyAmount(0, 2, 'EUR') }),
      account({ balance: moneyAmount(0, 2, 'EUR') }),
    ]
    expect(newAccountDraft(existing)).toEqual({
      name: '',
      currency: 'EUR',
      icon: 'wallet',
      colour: ACCOUNT_COLOURS[3],
      tags: [],
    })
  })

  it('leaves the currency blank for the first account', () => {
    expect(newAccountDraft([]).currency).toBe('')
    expect(newAccountDraft([]).colour).toBe(ACCOUNT_COLOURS[0])
  })
})

describe('validateDraft', () => {
  const valid = { name: 'Cash', currency: 'EUR', icon: 'wallet', colour: '#000000', tags: [] }

  it('accepts a complete draft', () => {
    expect(validateDraft(valid)).toEqual({})
  })

  it('requires a name', () => {
    expect(validateDraft({ ...valid, name: '   ' }).name).toBeDefined()
  })

  it('requires a currency code without spaces', () => {
    expect(validateDraft({ ...valid, currency: '' }).currency).toBeDefined()
    expect(validateDraft({ ...valid, currency: 'US D' }).currency).toBeDefined()
    expect(validateDraft({ ...valid, currency: ' btc ' })).toEqual({})
  })
})

describe('normaliseDraft', () => {
  it('trims, upper-cases the currency and cleans the tags', () => {
    expect(
      normaliseDraft({
        name: '  Cash ',
        currency: ' usdt ',
        icon: 'wallet',
        colour: '#000000',
        tags: [' daily', 'daily', '', 'trip '],
      }),
    ).toEqual({
      name: 'Cash',
      currency: 'USDT',
      icon: 'wallet',
      colour: '#000000',
      tags: ['daily', 'trip'],
    })
  })
})

describe('patchFromDraft', () => {
  it('is empty when nothing changed', () => {
    const a = account()
    expect(patchFromDraft(a, draftFromAccount(a))).toEqual({})
  })

  it('contains only the changed fields', () => {
    const a = account()
    const patch = patchFromDraft(a, {
      ...draftFromAccount(a),
      name: 'Pocket',
      tags: ['daily', 'x'],
    })
    expect(patch).toEqual({ name: 'Pocket', tags: ['daily', 'x'] })
  })

  it('changes the currency but keeps the stored amount', () => {
    const a = account({ balance: moneyAmount(1234, 2, 'EUR') })
    const patch = patchFromDraft(a, { ...draftFromAccount(a), currency: 'USD' })
    expect(patch.balance).toEqual(moneyAmount(1234, 2, 'USD'))
  })
})

describe('createInputFromDraft', () => {
  it('starts the account at a zero balance in its currency', () => {
    const input = createInputFromDraft({
      name: 'Card',
      currency: 'GBP',
      icon: 'credit-card',
      colour: '#3b82f6',
      tags: [],
    })
    expect(input.balance).toEqual(moneyAmount(0, 2, 'GBP'))
    expect(input.location_id).toBeNull()
  })
})

describe('currencySuggestions', () => {
  it('lists currencies already in use first, then other codes matching the prefix', () => {
    const existing = [account({ balance: moneyAmount(0, 8, 'BTC') })]
    const result = currencySuggestions('b', existing)
    expect(result[0]).toBe('BTC')
    expect(result).toContain('BRL')
    expect(result.every((c) => c.startsWith('B'))).toBe(true)
    expect(new Set(result).size).toBe(result.length)
  })
})

describe('accountIconClass', () => {
  it('renders a known icon and falls back to the wallet icon', () => {
    expect(accountIconClass('credit-card')).toBe('pi pi-credit-card')
    expect(accountIconClass('no-such-icon')).toBe('pi pi-wallet')
  })
})

describe('iconColourOn', () => {
  it('picks dark ink on light backgrounds and white on dark ones', () => {
    expect(iconColourOn('#fde047')).toBe('#111827')
    expect(iconColourOn('#1e3a8a')).toBe('#ffffff')
    expect(iconColourOn('not a colour')).toBe('#ffffff')
  })
})
