import { describe, it, expect } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { asShortId } from '@/db/shortId'
import type { Tag } from '@/db/types'
import { byId, tag } from '@/tags/__tests__/fixtures'
import { accountTagChips, tagForName } from '../accountTags'

const plain = (id: string, over: Partial<Tag> = {}) => tag(id, { kind: 'tag', ...over })
const ids = (...names: string[]) => names.map(asShortId)
const EARLY = new Date('2020-01-01T00:00:00.000Z')
const GONE = new Date('2026-10-27T00:00:00.000Z')

describe('accountTagChips', () => {
  const tags = [
    plain('family', { colour: '#ef4444', icon: primeIcon('heart') }),
    plain('mia', { parent_id: asShortId('family') }),
    plain('old', { archived_at_utc: GONE }),
    plain('gone', { deleted_at_utc: GONE }),
  ]

  it('labels a nested tag by its path and gives it its inherited look', () => {
    expect(accountTagChips(ids('mia'), byId(...tags))).toEqual([
      {
        id: 'mia',
        label: 'family › mia',
        icon: primeIcon('heart'),
        colour: '#ef4444',
        fallback: primeIcon('hashtag'),
        archived: false,
      },
    ])
  })

  it('keeps the order, leaves out deleted and unknown tags and marks archived ones', () => {
    const chips = accountTagChips(ids('old', 'gone', 'nowhere', 'family'), byId(...tags))
    expect(chips.map((c) => [c.label, c.archived])).toEqual([
      ['old', true],
      ['family', false],
    ])
  })
})

describe('tagForName', () => {
  const none = new Map()

  it('prefers a known tag, then the oldest live one, by main name before a synonym', () => {
    const tags = [
      plain('top', { name: 'mia', created_at_utc: EARLY }),
      plain('nested', { name: 'mia', parent_id: asShortId('top') }),
      plain('kids', { synonyms: ['Mia'], created_at_utc: EARLY }),
    ]
    expect(tagForName(' MIA ', ids('nested'), tags, none)?.id).toBe('nested')
    expect(tagForName('mia', [], tags, none)?.id).toBe('top')
    expect(tagForName('mia', ids('kids'), tags, none)?.id).toBe('kids')
  })

  it('finds a synonym, then a merged name, and nothing for a new name', () => {
    const tags = [
      plain('kids', { synonyms: ['Mimi'] }),
      plain('work'),
      plain('gone', { name: 'office', deleted_at_utc: GONE }),
      tag('cat', { name: 'pets' }), // a category
    ]
    const merged = new Map([[asShortId('work'), ['Office']]])
    expect(tagForName('mimi', [], tags, merged)?.id).toBe('kids')
    expect(tagForName('office', [], tags, merged)?.id).toBe('work')
    expect(tagForName('pets', [], tags, merged)).toBeUndefined()
    expect(tagForName('brand new', [], tags, merged)).toBeUndefined()
  })
})
