import { describe, it, expect } from 'vitest'
import { ACCOUNT_COLOURS } from '@/components/accounts/accountForm'
import { asShortId, type ShortId } from '@/db/shortId'
import type { Tag } from '@/db/types'
import { KIND_ICONS, effectiveLook, newTagLook } from '../look'

const AT = new Date('2026-10-26T00:00:00.000Z')

function tag(id: string, over: Partial<Tag> = {}): Tag {
  return {
    id: asShortId(id),
    kind: 'category',
    name: id,
    parent_id: null,
    moved_at_utc: AT,
    description: null,
    synonyms: [],
    colour: null,
    icon: null,
    merged_into_id: null,
    created_at_utc: AT,
    updated_at_utc: AT,
    deleted_at_utc: null,
    ...over,
  }
}

function byId(...tags: Tag[]): Map<ShortId, Tag> {
  return new Map(tags.map((t) => [t.id, t]))
}

describe('KIND_ICONS', () => {
  it('gives each kind its PrimeIcons name', () => {
    expect(KIND_ICONS).toEqual({
      category: 'tag',
      merchant: 'shop',
      location: 'map-marker',
      journey: 'globe',
      tag: 'hashtag',
    })
  })
})

describe('effectiveLook', () => {
  it('inherits from the nearest ancestor that sets a value', () => {
    const food = tag('food', { colour: '#111111', icon: 'star' })
    const groceries = tag('groceries', { parent_id: food.id, colour: '#222222' })
    const organic = tag('organic', { parent_id: groceries.id })

    expect(effectiveLook(organic, byId(food, groceries, organic))).toEqual({
      colour: '#222222',
      icon: 'star',
    })
  })

  it('prefers the tag’s own values', () => {
    const food = tag('food', { colour: '#111111', icon: 'star' })
    const posh = tag('posh', { parent_id: food.id, colour: '#333333', icon: 'heart' })

    expect(effectiveLook(posh, byId(food, posh))).toEqual({ colour: '#333333', icon: 'heart' })
  })

  it('falls back to the kind icon and a stable preset colour', () => {
    const rewe = tag('Ab3dEf6hIj9L', { kind: 'merchant' })
    const city = tag('Zz0yXw1vUt2S', { kind: 'merchant', parent_id: rewe.id })
    const all = byId(rewe, city)

    const look = effectiveLook(rewe, all)
    expect(look.icon).toBe('shop')
    expect(ACCOUNT_COLOURS).toContain(look.colour)
    expect(effectiveLook(rewe, all)).toEqual(look)
    // The fallback follows the top of the tree, so a subtree keeps one colour.
    expect(effectiveLook(city, all)).toEqual(look)
  })

  it('stops at a parent missing from the map, and on a parent loop left by sync', () => {
    const orphan = tag('orphan', { parent_id: asShortId('gone'), icon: 'star' })
    expect(effectiveLook(orphan, byId(orphan)).icon).toBe('star')

    const a = tag('a', { parent_id: asShortId('b') })
    const b = tag('b', { parent_id: asShortId('a') })
    expect(effectiveLook(a, byId(a, b)).icon).toBe('tag')
  })
})

describe('newTagLook', () => {
  it('uses the injected random to pick a preset colour, and the kind icon', () => {
    expect(newTagLook('journey', () => 0)).toEqual({
      colour: ACCOUNT_COLOURS[0],
      icon: 'globe',
    })
    expect(newTagLook('tag', () => 0.999).colour).toBe(ACCOUNT_COLOURS[ACCOUNT_COLOURS.length - 1])
    expect(newTagLook('location', () => 0.5)).toEqual({
      colour: ACCOUNT_COLOURS[Math.floor(ACCOUNT_COLOURS.length / 2)],
      icon: 'map-marker',
    })
  })

  it('picks a preset by default', () => {
    expect(ACCOUNT_COLOURS).toContain(newTagLook('category').colour)
  })
})
