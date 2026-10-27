import { describe, it, expect } from 'vitest'
import { COLOUR_PRESETS } from '@/format/colours'
import { KIND_ICONS, effectiveLook, newTagLook } from '../look'
import { byId, tag } from './fixtures'
import { asShortId } from '@/db/shortId'

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
    expect(COLOUR_PRESETS).toContain(look.colour)
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
      colour: COLOUR_PRESETS[0],
      icon: 'globe',
    })
    expect(newTagLook('tag', () => 0.999).colour).toBe(COLOUR_PRESETS[COLOUR_PRESETS.length - 1])
    expect(newTagLook('location', () => 0.5)).toEqual({
      colour: COLOUR_PRESETS[Math.floor(COLOUR_PRESETS.length / 2)],
      icon: 'map-marker',
    })
  })

  it('picks a preset by default', () => {
    expect(COLOUR_PRESETS).toContain(newTagLook('category').colour)
  })
})
