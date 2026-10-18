import { describe, it, expect, beforeEach } from 'vitest'
import { jsonStore, nullableJsonStore, stringStore } from '../../localState/storage'

describe('storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('stringStore', () => {
    it('returns null when nothing is stored', () => {
      const s = stringStore('s1')
      expect(s.load()).toBeNull()
    })

    it('round-trips a string and prefixes the key with moneytracker.sync.', () => {
      const s = stringStore('s2')
      s.save('hello')
      expect(s.load()).toBe('hello')
      expect(localStorage.getItem('moneytracker.sync.s2')).toBe('hello')
    })

    it('clears the stored value', () => {
      const s = stringStore('s3')
      s.save('x')
      s.clear()
      expect(s.load()).toBeNull()
    })
  })

  describe('nullableJsonStore', () => {
    interface Snap {
      who: string
      when: string
    }

    it('returns null when nothing is stored', () => {
      const s = nullableJsonStore<Snap>('n1')
      expect(s.load()).toBeNull()
    })

    it('round-trips a JSON value', () => {
      const s = nullableJsonStore<Snap>('n2')
      s.save({ who: 'a', when: 'b' })
      expect(s.load()).toEqual({ who: 'a', when: 'b' })
    })

    it('save(null) clears the slot so subsequent loads return null', () => {
      const s = nullableJsonStore<Snap>('n3')
      s.save({ who: 'a', when: 'b' })
      s.save(null)
      expect(s.load()).toBeNull()
    })

    it('returns null when the stored JSON is malformed', () => {
      localStorage.setItem('moneytracker.sync.n4', 'not json')
      const s = nullableJsonStore<Snap>('n4')
      expect(s.load()).toBeNull()
    })
  })

  describe('jsonStore', () => {
    interface Cfg {
      active: string
      supabase: { url: string; key: string }
    }
    const DEFAULT: Cfg = { active: 'none', supabase: { url: '', key: '' } }

    it('returns the default when nothing is stored', () => {
      const s = jsonStore<Cfg>('j1', DEFAULT)
      expect(s.load()).toEqual(DEFAULT)
    })

    it('round-trips a full value', () => {
      const s = jsonStore<Cfg>('j2', DEFAULT)
      const value: Cfg = { active: 'supabase', supabase: { url: 'u', key: 'k' } }
      s.save(value)
      expect(s.load()).toEqual(value)
    })

    it('merges a partial stored value over the default (forward compatibility)', () => {
      // Simulates an older app version writing `{active: "supabase"}` without
      // the `supabase` sub-object that we added in this release. The reader
      // should fill the missing field from the default rather than crashing.
      localStorage.setItem('moneytracker.sync.j3', JSON.stringify({ active: 'supabase' }))
      const s = jsonStore<Cfg>('j3', DEFAULT)
      expect(s.load()).toEqual({ active: 'supabase', supabase: { url: '', key: '' } })
    })

    it('returns the default when the stored JSON is malformed', () => {
      localStorage.setItem('moneytracker.sync.j4', 'not json')
      const s = jsonStore<Cfg>('j4', DEFAULT)
      expect(s.load()).toEqual(DEFAULT)
    })

    it('returns a fresh copy of the default so callers cannot mutate it', () => {
      const s = jsonStore<Cfg>('j5', DEFAULT)
      const first = s.load()
      first.active = 'mutated'
      expect(s.load().active).toBe('none')
    })
  })
})
