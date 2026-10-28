import { describe, it, expect } from 'vitest'
import { ICON_SETS, QUICK_ICONS, iconLabel, isPrimeIcon, primeIcon, setIconClass } from '../sets'
import { PRIME_ICONS } from '../primeIcons'
import { emojiIcon, imageIcon, setIcon } from '../types'
import { asUuid } from '@/db/uuid'

describe('icon packs', () => {
  it('registers PrimeIcons as the set "pi"', () => {
    expect(ICON_SETS.map((s) => s.id)).toEqual(['pi'])
    expect(ICON_SETS[0]!.names).toBe(PRIME_ICONS)
  })

  it('lists every PrimeIcons icon alphabetically', () => {
    expect(PRIME_ICONS).toEqual([...PRIME_ICONS].sort())
    expect(PRIME_ICONS).toContain('euro')
    expect(PRIME_ICONS).toContain('wallet')
  })

  it('draws any icon of a known pack, and nothing for an unknown pack or name', () => {
    expect(setIconClass(primeIcon('credit-card'))).toBe('pi pi-credit-card')
    expect(setIconClass(primeIcon('euro'))).toBe('pi pi-euro')
    expect(setIconClass(primeIcon('no-such-icon'))).toBeNull()
    expect(setIconClass(setIcon('material', 'wallet'))).toBeNull()
  })

  it('tells a PrimeIcons icon by name', () => {
    expect(isPrimeIcon(primeIcon('car'), 'car')).toBe(true)
    expect(isPrimeIcon(primeIcon('car'), 'home')).toBe(false)
    expect(isPrimeIcon(setIcon('material', 'car'), 'car')).toBe(false)
    expect(isPrimeIcon(emojiIcon('🚗'), 'car')).toBe(false)
  })

  it('keeps currency signs out of the quick icons, and offers only real ones', () => {
    expect(QUICK_ICONS).not.toContain('dollar')
    expect(QUICK_ICONS).not.toContain('euro')
    expect(QUICK_ICONS).not.toContain('pound')
    for (const name of QUICK_ICONS) expect(PRIME_ICONS).toContain(name)
  })

  it('names icons readably', () => {
    expect(iconLabel(primeIcon('credit-card'))).toBe('credit card')
    expect(iconLabel(primeIcon('building-columns'))).toBe('bank')
    expect(iconLabel(emojiIcon('🛒'))).toBe('🛒')
    expect(iconLabel(imageIcon(asUuid('00000000-0000-5000-8000-000000000000')))).toBe('picture')
    expect(iconLabel({ kind: 'unknown', json: '{}' })).toBe('unknown icon')
  })
})
