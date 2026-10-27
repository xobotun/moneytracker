import { COLOUR_PRESETS } from '@/format/colours'
import type { ShortId } from '@/db/shortId'
import type { Tag, TagKind } from '@/db/types'

// How a tag looks: its colour and icon. A tag that sets neither inherits them
// from its parent, so a tree shares one look unless a branch sets its own.

/** The default icon of each kind (PrimeIcons names, without `pi-`). */
export const KIND_ICONS: Record<TagKind, string> = {
  category: 'tag',
  merchant: 'shop',
  location: 'map-marker',
  journey: 'globe', // PrimeIcons has no plane
  tag: 'hashtag',
}

export interface TagLook {
  colour: string
  icon: string
}

/** The look a new top-level tag starts with: a random preset colour and its kind's icon. */
export function newTagLook(kind: TagKind, random: () => number = Math.random): TagLook {
  const index = Math.min(Math.floor(random() * COLOUR_PRESETS.length), COLOUR_PRESETS.length - 1)
  return { colour: COLOUR_PRESETS[index]!, icon: KIND_ICONS[kind] }
}

/**
 * The colour and icon a tag shows: the first ones set on the way up from the
 * tag through its parents. With none set, the icon is the kind's and the
 * colour a preset chosen by the id of the topmost tag reached, so the same
 * tree always gets the same colour on every device.
 */
export function effectiveLook(tag: Tag, byId: ReadonlyMap<ShortId, Tag>): TagLook {
  let colour: string | null = null
  let icon: string | null = null
  let top = tag
  // Sync can leave a parent loop until it is repaired; never walk one twice.
  const seen = new Set<ShortId>()
  for (let current: Tag | undefined = tag; current && !seen.has(current.id); ) {
    seen.add(current.id)
    top = current
    colour ??= current.colour
    icon ??= current.icon
    if (colour !== null && icon !== null) break
    current = current.parent_id === null ? undefined : byId.get(current.parent_id)
  }
  return {
    colour: colour ?? COLOUR_PRESETS[stringHash(top.id) % COLOUR_PRESETS.length]!,
    icon: icon ?? KIND_ICONS[tag.kind],
  }
}

/**
 * A stable, non-negative hash of a string (31-multiplier polynomial over the
 * UTF-16 code units, kept in 32 unsigned bits). Only for picking a preset;
 * never changes between runs or devices.
 */
function stringHash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  }
  return hash
}
