import { describe, it, expect } from 'vitest'
import { primeIcon } from '@/icons/sets'
import { COLOUR_PRESETS } from '@/format/colours'
import { KIND_ICONS, effectiveLook, inheritedLook, newTagLook } from '../look'
import { byId, tag } from './fixtures'
import { asShortId } from '@/db/shortId'

describe('KIND_ICONS', () => {
  it('gives each kind a PrimeIcons icon', () => {
    expect(KIND_ICONS).toEqual({
      category: primeIcon('tag'),
      merchant: primeIcon('shop'),
      location: primeIcon('map-marker'),
      journey: primeIcon('globe'),
      tag: primeIcon('hashtag'),
    })
  })
})

describe('effectiveLook', () => {
  it('inherits from the nearest ancestor that sets a value', () => {
    const food = tag('food', { colour: '#111111', icon: primeIcon('star') })
    const groceries = tag('groceries', { parent_id: food.id, colour: '#222222' })
    const organic = tag('organic', { parent_id: groceries.id })

    expect(effectiveLook(organic, byId(food, groceries, organic))).toEqual({
      colour: '#222222',
      icon: primeIcon('star'),
      fallback: KIND_ICONS.category,
    })
  })

  it('prefers the tag’s own values', () => {
    const food = tag('food', { colour: '#111111', icon: primeIcon('star') })
    const posh = tag('posh', { parent_id: food.id, colour: '#333333', icon: primeIcon('heart') })

    expect(effectiveLook(posh, byId(food, posh))).toEqual({
      colour: '#333333',
      icon: primeIcon('heart'),
      fallback: KIND_ICONS.category,
    })
  })

  it('falls back to the kind icon and a stable preset colour', () => {
    const rewe = tag('Ab3dEf6hIj9L', { kind: 'merchant' })
    const city = tag('Zz0yXw1vUt2S', { kind: 'merchant', parent_id: rewe.id })
    const all = byId(rewe, city)

    const look = effectiveLook(rewe, all)
    expect(look.icon).toEqual(primeIcon('shop'))
    expect(look.fallback).toEqual(primeIcon('shop'))
    expect(COLOUR_PRESETS).toContain(look.colour)
    expect(effectiveLook(rewe, all)).toEqual(look)
    // The fallback follows the top of the tree, so a subtree keeps one colour.
    expect(effectiveLook(city, all)).toEqual(look)
  })

  it('stops at a parent missing from the map, and on a parent loop left by sync', () => {
    const orphan = tag('orphan', { parent_id: asShortId('gone'), icon: primeIcon('star') })
    expect(effectiveLook(orphan, byId(orphan)).icon).toEqual(primeIcon('star'))

    const a = tag('a', { parent_id: asShortId('b') })
    const b = tag('b', { parent_id: asShortId('a') })
    expect(effectiveLook(a, byId(a, b)).icon).toEqual(primeIcon('tag'))
  })
})

describe('newTagLook', () => {
  it('uses the injected random to pick a preset colour, and the kind icon', () => {
    expect(newTagLook('journey', () => 0)).toEqual({
      colour: COLOUR_PRESETS[0],
      icon: primeIcon('globe'),
    })
    expect(newTagLook('tag', () => 0.999).colour).toBe(COLOUR_PRESETS[COLOUR_PRESETS.length - 1])
    expect(newTagLook('location', () => 0.5)).toEqual({
      colour: COLOUR_PRESETS[Math.floor(COLOUR_PRESETS.length / 2)],
      icon: primeIcon('map-marker'),
    })
  })

  it('picks a preset by default', () => {
    expect(COLOUR_PRESETS).toContain(newTagLook('category').colour)
  })
})

describe('inheritedLook', () => {
  it('names the ancestors the colour and the icon come from', () => {
    const food = tag('food', { colour: '#ef4444' })
    const groceries = tag('groceries', { parent_id: food.id, icon: primeIcon('shopping-cart') })
    const look = inheritedLook('category', groceries.id, null, byId(food, groceries))
    expect(look).toEqual({
      colour: '#ef4444',
      icon: primeIcon('shopping-cart'),
      fallback: KIND_ICONS.category,
      colourFrom: food,
      iconFrom: groceries,
    })
  })

  it('is what the tag will show once saved under that parent', () => {
    const food = tag('food')
    const snacks = tag('snacks', { parent_id: food.id })
    const map = byId(food, snacks)
    const { colour, icon, fallback } = inheritedLook('category', food.id, snacks.id, map)
    expect({ colour, icon, fallback }).toEqual(effectiveLook(snacks, map))
  })

  it('at the top level is the default: the kind icon and a preset by the tag id', () => {
    const own = tag('abc', { kind: 'merchant' })
    expect(inheritedLook('merchant', null, own.id, byId(own))).toEqual({
      ...effectiveLook(own, byId(own)),
      icon: KIND_ICONS.merchant,
      colourFrom: null,
      iconFrom: null,
    })
  })
})
