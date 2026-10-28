import { describe, it, expect } from 'vitest'
import { asShortId } from '@/db/shortId'
import { noDetails } from '@/db/repositories/TagDetailsRepository'
import { COLOUR_PRESETS } from '@/format/colours'
import { tag } from '@/tags/__tests__/fixtures'
import {
  createInputFromDraft,
  draftFromTag,
  newTagDraft,
  saveInputFromDraft,
  validateDraft,
  type TagDraft,
} from '../tagForm'

const PARENT = asShortId('parent000001')

describe('newTagDraft', () => {
  it('starts a location at the default radius; other kinds have none', () => {
    expect(newTagDraft('location', null).radius_metres).toBe(10)
    expect(newTagDraft('merchant', null).radius_metres).toBeNull()
  })

  it("gives a top-level tag a preset colour and its kind's icon", () => {
    const draft = newTagDraft('merchant', null, () => 0)
    expect(draft).toMatchObject({
      name: '',
      parent_id: null,
      colour: COLOUR_PRESETS[0],
      icon: 'shop',
    })
  })

  it('lets a child inherit both', () => {
    expect(newTagDraft('category', PARENT)).toMatchObject({
      parent_id: PARENT,
      colour: null,
      icon: null,
    })
  })
})

describe('draftFromTag', () => {
  it('lists synonyms then merged names, and maps the details', () => {
    const rewe = tag('rewe', {
      kind: 'location',
      name: 'Rewe',
      parent_id: PARENT,
      synonyms: ['REWE Markt'],
      description: null,
    })
    const draft = draftFromTag(
      rewe,
      { ...noDetails(), address: 'Weg 1', position: { latitude: 52.5, longitude: 13.4 } },
      ['Billa'],
    )
    expect(draft).toMatchObject({
      name: 'Rewe',
      parent_id: PARENT,
      otherNames: ['REWE Markt', 'Billa'],
      description: '',
      address: 'Weg 1',
      latitude: 52.5,
      longitude: 13.4,
    })
  })
})

describe('validateDraft', () => {
  const valid: TagDraft = { ...newTagDraft('location', null), name: 'Rewe' }

  it('accepts a named tag', () => {
    expect(validateDraft(valid)).toEqual({})
  })

  it('refuses a missing name', () => {
    expect(validateDraft({ ...valid, name: '  ' })).toEqual({ name: 'Give the tag a name.' })
  })

  it('refuses a lone or out-of-range coordinate', () => {
    expect(validateDraft({ ...valid, latitude: 52.5 })).toEqual({
      position: 'Enter both coordinates or neither.',
    })
    const range = 'Latitude goes from −90 to 90, longitude from −180 to 180.'
    expect(validateDraft({ ...valid, latitude: 91, longitude: 0 })).toEqual({ position: range })
    expect(validateDraft({ ...valid, latitude: 0, longitude: -180.5 })).toEqual({ position: range })
    expect(validateDraft({ ...valid, latitude: -90, longitude: 180 })).toEqual({})
  })

  it('refuses a radius that is no whole number of metres, at least 1', () => {
    const radius = 'The radius is a whole number of metres, at least 1.'
    expect(validateDraft({ ...valid, radius_metres: 0 })).toEqual({ radius })
    expect(validateDraft({ ...valid, radius_metres: 2.5 })).toEqual({ radius })
    expect(validateDraft({ ...valid, radius_metres: 1 })).toEqual({})
    // Empty is the default.
    expect(validateDraft({ ...valid, radius_metres: null })).toEqual({})
  })

  it('refuses an end before the start, when both are typed', () => {
    expect(validateDraft({ ...valid, start_date: '2026-05-09', end_date: '2026-05-01' })).toEqual({
      dates: 'The journey cannot end before it starts.',
    })
    expect(validateDraft({ ...valid, start_date: '2026-05-09', end_date: null })).toEqual({})
  })
})

describe('saveInputFromDraft', () => {
  it('trims and maps empty text to null', () => {
    const draft: TagDraft = {
      ...newTagDraft('location', PARENT),
      name: ' Rewe ',
      description: '  ',
      otherNames: ['Billa'],
      address: ' ',
      latitude: 52.5,
      longitude: 13.4,
    }
    expect(saveInputFromDraft(draft)).toEqual({
      name: 'Rewe',
      parent_id: PARENT,
      description: null,
      otherNames: ['Billa'],
      colour: null,
      icon: null,
      details: { ...noDetails(), position: { latitude: 52.5, longitude: 13.4 }, radius_metres: 10 },
    })
  })
})

describe('createInputFromDraft', () => {
  it('creates a tag of the kind with its synonyms and details', () => {
    const draft: TagDraft = {
      ...newTagDraft('journey', null, () => 0),
      name: 'Rome',
      otherNames: [' Roma ', 'rome'],
      start_date: '2026-05-01',
    }
    expect(createInputFromDraft('journey', draft)).toEqual({
      kind: 'journey',
      name: 'Rome',
      parent_id: null,
      description: null,
      synonyms: ['Roma'],
      colour: COLOUR_PRESETS[0],
      icon: 'globe',
      details: { ...noDetails(), start_date: '2026-05-01' },
    })
  })
})
