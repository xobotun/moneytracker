import { describe, it, expect } from 'vitest'
import type { ShortId } from '@/db/shortId'
import type { Tag, TagDetailValues } from '@/db/types'
import { circleStyle, mapLocations } from '../locationsMap'
import { tag } from './fixtures'

const location = (id: string, over: Partial<Tag> = {}) => tag(id, { kind: 'location', ...over })

function placed(
  latitude: number,
  longitude: number,
  over: Partial<TagDetailValues> = {},
): TagDetailValues {
  return {
    address: null,
    position: { latitude, longitude },
    merchant_id: null,
    radius_metres: 10,
    auto_match: true,
    default_category_id: null,
    start_date: null,
    end_date: null,
    ...over,
  }
}

const all = () => true

describe('mapLocations', () => {
  it('shows each live placed location with its position, radius, look and matching', () => {
    const berlin = location('berlin', { colour: '#112233', icon: 'building' })
    const store = location('store', { parent_id: berlin.id })
    const details = new Map<ShortId, TagDetailValues>([
      [berlin.id, placed(52.52, 13.405, { radius_metres: 9000 })],
      [store.id, placed(52.5, 13.4, { radius_metres: 30, auto_match: false })],
    ])
    const { shown, unplaced } = mapLocations([berlin, store], details, all)
    expect(unplaced).toBe(0)
    expect(shown.map(({ tag, ...rest }) => ({ id: tag.id, ...rest }))).toEqual([
      {
        id: 'berlin',
        latitude: 52.52,
        longitude: 13.405,
        radius: 9000,
        colour: '#112233',
        icon: 'building',
        autoMatch: true,
      },
      // The store inherits its parent's look.
      {
        id: 'store',
        latitude: 52.5,
        longitude: 13.4,
        radius: 30,
        colour: '#112233',
        icon: 'building',
        autoMatch: false,
      },
    ])
  })

  it('counts the matching locations without a position, and leaves them off the map', () => {
    const a = location('a')
    const b = location('b')
    const c = location('c')
    const details = new Map<ShortId, TagDetailValues>([
      [a.id, placed(1, 2)],
      [b.id, { ...placed(0, 0), position: null, address: 'Weg 1' }],
    ])
    const { shown, unplaced } = mapLocations([a, b, c], details, all)
    expect(shown.map((l) => l.tag.id)).toEqual(['a'])
    expect(unplaced).toBe(2)
  })

  it('keeps to the tags that pass the filter', () => {
    const rewe = location('Rewe')
    const edeka = location('Edeka')
    const nowhere = location('Rewe Nowhere')
    const details = new Map<ShortId, TagDetailValues>([
      [rewe.id, placed(1, 2)],
      [edeka.id, placed(3, 4)],
    ])
    const { shown, unplaced } = mapLocations([rewe, edeka, nowhere], details, (t) =>
      t.name.startsWith('Rewe'),
    )
    expect(shown.map((l) => l.tag.id)).toEqual(['Rewe'])
    expect(unplaced).toBe(1)
  })

  it('leaves out deleted locations and tags of other kinds', () => {
    const live = location('live')
    const gone = location('gone', { deleted_at_utc: new Date('2026-10-27T00:00:00.000Z') })
    const merchant = tag('merchant', { kind: 'merchant' })
    const details = new Map<ShortId, TagDetailValues>([
      [live.id, placed(1, 2)],
      [gone.id, placed(1, 2)],
      [merchant.id, placed(1, 2)],
    ])
    const { shown, unplaced } = mapLocations([live, gone, merchant, location('none')], details, all)
    expect(shown.map((l) => l.tag.id)).toEqual(['live'])
    expect(unplaced).toBe(1)
  })

  it('takes the default radius when none is set, and matching as on unless switched off', () => {
    const a = location('a')
    const details = new Map<ShortId, TagDetailValues>([
      [a.id, placed(1, 2, { radius_metres: null, auto_match: null })],
    ])
    const [shown] = mapLocations([a], details, all).shown
    expect(shown).toMatchObject({ radius: 10, autoMatch: true })
  })

  it('puts the largest circles first', () => {
    const tags = [location('small'), location('city'), location('mid')]
    const radii = { small: 10, city: 9000, mid: 300 }
    const details = new Map<ShortId, TagDetailValues>(
      tags.map((t) => [t.id, placed(1, 2, { radius_metres: radii[t.id as keyof typeof radii] })]),
    )
    expect(mapLocations(tags, details, all).shown.map((l) => l.tag.id)).toEqual([
      'city',
      'mid',
      'small',
    ])
  })

  it('handles 1,000 locations', () => {
    const tags = Array.from({ length: 1000 }, (_, i) => location(`loc${i}`))
    const details = new Map<ShortId, TagDetailValues>(
      tags.map((t, i) => [
        t.id,
        placed(52.4 + i / 5000, 13.25 + i / 3500, { radius_metres: i + 1 }),
      ]),
    )
    const { shown, unplaced } = mapLocations(tags, details, all)
    expect(shown).toHaveLength(1000)
    expect(unplaced).toBe(0)
    expect(shown[0]!.radius).toBe(1000)
    expect(shown[999]!.radius).toBe(1)
  })
})

describe('circleStyle', () => {
  it("draws in the tag's colour, nearly clear inside, solid when matched automatically", () => {
    const style = circleStyle('#ff0000', true)
    expect(style).toMatchObject({ color: '#ff0000', fillColor: '#ff0000' })
    expect(style.fillOpacity).toBeLessThanOrEqual(0.12)
    expect(style.dashArray).toBeUndefined()
  })

  it('dashes the circle of a location that is not matched automatically', () => {
    expect(circleStyle('#ff0000', false).dashArray).toBe('6 4')
  })
})
