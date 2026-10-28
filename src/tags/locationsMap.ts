import type { PathOptions } from 'leaflet'
import type { ShortId } from '@/db/shortId'
import type { Tag, TagDetailValues } from '@/db/types'
import { DEFAULT_LOCATION_RADIUS_METRES } from '@/db/repositories/TagDetailsRepository'
import { effectiveLook } from './look'

// What the map of all locations shows, kept out of the component so it can be
// tested without Leaflet.

/** A placed location as the map draws it: a circle of its radius, its icon at the centre. */
export interface MapLocation {
  tag: Tag
  latitude: number
  longitude: number
  /** In metres. */
  radius: number
  colour: string
  icon: string
  autoMatch: boolean
}

/**
 * The live locations that pass `matches` and have a position, largest circle
 * first (so the map draws the small ones on top), and how many of them have
 * no position. One pass over the tags; each look is read from a map built once.
 */
export function mapLocations(
  tags: readonly Tag[],
  detailsById: ReadonlyMap<ShortId, TagDetailValues>,
  matches: (tag: Tag) => boolean,
): { shown: MapLocation[]; unplaced: number } {
  const byId = new Map<ShortId, Tag>(tags.map((t) => [t.id, t]))
  const shown: MapLocation[] = []
  let unplaced = 0
  for (const tag of tags) {
    if (tag.kind !== 'location' || tag.deleted_at_utc !== null || !matches(tag)) continue
    const details = detailsById.get(tag.id)
    if (!details?.position) {
      unplaced++
      continue
    }
    const { colour, icon } = effectiveLook(tag, byId)
    shown.push({
      tag,
      latitude: details.position.latitude,
      longitude: details.position.longitude,
      radius: details.radius_metres ?? DEFAULT_LOCATION_RADIUS_METRES,
      colour,
      icon,
      autoMatch: details.auto_match !== false,
    })
  }
  shown.sort((a, b) => b.radius - a.radius)
  return { shown, unplaced }
}

/**
 * How a location's circle is drawn: its tag's colour, the fill nearly clear so
 * the map shows through nested places, dashed when it is not matched automatically.
 */
export function circleStyle(colour: string, autoMatch: boolean): PathOptions {
  return {
    color: colour,
    weight: 1.5,
    opacity: 0.9,
    fillColor: colour,
    fillOpacity: 0.1,
    ...(autoMatch ? {} : { dashArray: '6 4' }),
  }
}
