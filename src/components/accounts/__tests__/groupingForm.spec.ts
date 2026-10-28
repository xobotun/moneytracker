import { describe, it, expect } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { asShortId } from '@/db/shortId'
import type { AccountGrouping } from '@/db/types'
import { COLOUR_PRESETS } from '@/format/colours'
import {
  draftFromGrouping,
  groupingPatchFromDraft,
  newGroupingDraft,
  normaliseGroupingDraft,
  validateGroupingDraft,
} from '../groupingForm'

function grouping(over: Partial<AccountGrouping> = {}): AccountGrouping {
  return {
    id: asShortId('GroupingAAAA'),
    name: 'Trip',
    colour: '#3b82f6',
    icon: primeIcon('car'),
    sort_order: 0,
    created_at_utc: new Date('2026-10-01T00:00:00Z'),
    updated_at_utc: new Date('2026-10-01T00:00:00Z'),
    deleted_at_utc: null,
    ...over,
  }
}

describe('groupingForm', () => {
  it('starts a new group with the folder icon and the next palette colour', () => {
    expect(newGroupingDraft([grouping()])).toEqual({
      name: '',
      icon: primeIcon('folder'),
      colour: COLOUR_PRESETS[1],
    })
  })

  it('requires a name', () => {
    expect(
      validateGroupingDraft({ name: '  ', icon: primeIcon('folder'), colour: '#000000' }).name,
    ).toBe('Give the group a name.')
    expect(
      validateGroupingDraft({ name: 'Trip', icon: primeIcon('folder'), colour: '#000000' }),
    ).toEqual({})
  })

  it('trims the name', () => {
    expect(
      normaliseGroupingDraft({ name: ' Trip ', icon: primeIcon('car'), colour: '#000000' }).name,
    ).toBe('Trip')
  })

  it('patches only the changed fields', () => {
    const g = grouping()
    expect(groupingPatchFromDraft(g, draftFromGrouping(g))).toEqual({})
    expect(groupingPatchFromDraft(g, { ...draftFromGrouping(g), name: 'Holiday' })).toEqual({
      name: 'Holiday',
    })
    // Icons compare by value: the same icon read again is no change.
    expect(groupingPatchFromDraft(g, { ...draftFromGrouping(g), icon: primeIcon('car') })).toEqual(
      {},
    )
    expect(groupingPatchFromDraft(g, { ...draftFromGrouping(g), icon: primeIcon('home') })).toEqual(
      {
        icon: primeIcon('home'),
      },
    )
  })
})
