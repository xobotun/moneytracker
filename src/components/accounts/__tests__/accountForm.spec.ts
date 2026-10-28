import { describe, it, expect } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { moneyAmount } from '@/db/MoneyAmount'
import { asShortId } from '@/db/shortId'
import type { Account } from '@/db/types'
import { COLOUR_PRESETS } from '@/format/colours'
import {
  createInputFromDraft,
  currenciesByUse,
  draftFromAccount,
  hiddenTagIds,
  newAccountDraft,
  normaliseDraft,
  patchFromDraft,
  tagIdsToSave,
  validateDraft,
} from '../accountForm'

const DAILY = asShortId('TagDaily0001')
const TAG_NAMES: Record<string, string> = { TagDaily0001: 'daily' }
const tagName = (id: string) => TAG_NAMES[id] ?? null

function account(over: Partial<Account> = {}): Account {
  return {
    id: asShortId('AccountAAAA1'),
    name: 'Cash',
    balance: moneyAmount(0, 2, 'EUR'),
    tags: [DAILY],
    is_cash: true,
    location_id: null,
    colour: '#22c55e',
    icon: primeIcon('wallet'),
    grouping_id: null,
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
      icon: primeIcon('wallet'),
      colour: COLOUR_PRESETS[3],
      tags: [],
      is_cash: false,
    })
  })

  it('leaves the currency blank for the first account', () => {
    expect(newAccountDraft([]).currency).toBe('')
    expect(newAccountDraft([]).colour).toBe(COLOUR_PRESETS[0])
  })
})

describe('validateDraft', () => {
  const valid = {
    name: 'Cash',
    currency: 'EUR',
    icon: primeIcon('wallet'),
    colour: '#000000',
    tags: [],
    is_cash: true,
  }

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
        icon: primeIcon('wallet'),
        colour: '#000000',
        tags: [' daily', 'daily', '', 'trip '],
        is_cash: true,
      }),
    ).toEqual({
      name: 'Cash',
      currency: 'USDT',
      icon: primeIcon('wallet'),
      colour: '#000000',
      tags: ['daily', 'trip'],
      is_cash: true,
    })
  })
})

describe('draftFromAccount', () => {
  it('edits tags by name and leaves out deleted or unknown ones', () => {
    const a = account({ tags: [DAILY, asShortId('TagGone00001')] })
    expect(draftFromAccount(a, tagName).tags).toEqual(['daily'])
    expect(hiddenTagIds(a, tagName)).toEqual(['TagGone00001'])
  })
})

describe('tagIdsToSave', () => {
  const GONE = asShortId('TagGone00001')
  const TRIP = asShortId('TagTrip00001')
  const NEW = asShortId('TagNew000001')

  it('keeps a deleted tag where it was, so a rename-only save writes only the name', () => {
    // The deleted tag sits between two live ones: it must not move to the end.
    const a = account({ tags: [DAILY, GONE, TRIP] })
    const names: Record<string, string> = { TagDaily0001: 'daily', TagTrip00001: 'trip' }
    const name = (id: string) => names[id] ?? null
    const draft = { ...draftFromAccount(a, name), name: 'Pocket' }
    // What resolving the draft's names ('daily', 'trip') gives.
    const toSave = tagIdsToSave(a.tags, [DAILY, TRIP], hiddenTagIds(a, name))
    expect(toSave).toEqual([DAILY, GONE, TRIP])
    expect(patchFromDraft(a, draft, toSave)).toEqual({ name: 'Pocket' })
  })

  it('keeps the stored ids when the tags could not be loaded', () => {
    const a = account({ tags: [DAILY, GONE] })
    const unknown = () => null // an empty tags store: every id is unknown
    const draft = draftFromAccount(a, unknown)
    expect(draft.tags).toEqual([])
    const toSave = tagIdsToSave(a.tags, [], hiddenTagIds(a, unknown))
    expect(toSave).toEqual([DAILY, GONE])
    expect(patchFromDraft(a, draft, toSave)).toEqual({})
    expect(patchFromDraft(a, { ...draft, name: 'Pocket' }, toSave)).toEqual({ name: 'Pocket' })
  })

  it('drops a removed tag and appends new ones, each once', () => {
    const a = account({ tags: [DAILY, GONE, TRIP] })
    expect(tagIdsToSave(a.tags, [TRIP, NEW, NEW], [GONE])).toEqual([GONE, TRIP, NEW])
  })
})

describe('patchFromDraft', () => {
  it('is empty when nothing changed', () => {
    const a = account()
    expect(patchFromDraft(a, draftFromAccount(a, tagName), [DAILY])).toEqual({})
  })

  it('compares icons by value, so an equal icon is no change', () => {
    const a = account({ icon: { kind: 'unknown', json: '{"kind":"sticker","id":7}' } })
    const draft = draftFromAccount(a, tagName)
    expect(patchFromDraft(a, { ...draft, icon: { ...draft.icon } }, [DAILY])).toEqual({})
    expect(patchFromDraft(a, { ...draft, icon: primeIcon('car') }, [DAILY])).toEqual({
      icon: primeIcon('car'),
    })
  })

  it('contains only the changed fields', () => {
    const a = account()
    const patch = patchFromDraft(
      a,
      {
        ...draftFromAccount(a, tagName),
        name: 'Pocket',
        tags: ['daily', 'x'],
      },
      [DAILY, asShortId('TagX00000001')],
    )
    expect(patch).toEqual({ name: 'Pocket', tags: [DAILY, 'TagX00000001'] })
  })

  it('carries a changed cash flag', () => {
    const a = account()
    expect(patchFromDraft(a, { ...draftFromAccount(a, tagName), is_cash: false }, [DAILY])).toEqual(
      {
        is_cash: false,
      },
    )
  })

  it('changes the currency but keeps the stored amount', () => {
    const a = account({ balance: moneyAmount(1234, 2, 'EUR') })
    const patch = patchFromDraft(a, { ...draftFromAccount(a, tagName), currency: 'USD' }, [DAILY])
    expect(patch.balance).toEqual(moneyAmount(1234, 2, 'USD'))
  })
})

describe('createInputFromDraft', () => {
  it('starts the account at a zero balance in its currency', () => {
    const input = createInputFromDraft(
      {
        name: 'Card',
        currency: 'GBP',
        icon: primeIcon('credit-card'),
        colour: '#3b82f6',
        tags: [],
        is_cash: true,
      },
      [DAILY],
    )
    expect(input.tags).toEqual([DAILY])
    expect(input.balance).toEqual(moneyAmount(0, 2, 'GBP'))
    expect(input.location_id).toBeNull()
    expect(input.is_cash).toBe(true)
  })
})

describe('currenciesByUse', () => {
  it('lists the currencies in use, most used first', () => {
    const existing = [
      account({ balance: moneyAmount(0, 2, 'USD') }),
      account({ balance: moneyAmount(0, 8, 'BTC') }),
      account({ balance: moneyAmount(0, 8, 'BTC') }),
    ]
    expect(currenciesByUse(existing)).toEqual(['BTC', 'USD'])
  })
})
