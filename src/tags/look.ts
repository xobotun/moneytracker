import { COLOUR_PRESETS } from '@/format/colours'
import type { ShortId } from '@/db/shortId'
import type { Tag, TagKind } from '@/db/types'
import type { Icon, SetIcon } from '@/icons/types'
import { primeIcon } from '@/icons/sets'

// How a tag looks: its colour and icon. A tag that sets neither inherits them
// from its parent, so a tree shares one look unless a branch sets its own.

/**
 * The default icon of each kind: what a new top-level tag starts with, and
 * what a tag shows when its own icon cannot be drawn (an unknown kind or pack
 * icon, a missing image).
 */
export const KIND_ICONS: Record<TagKind, SetIcon> = {
  category: primeIcon('tag'),
  merchant: primeIcon('shop'),
  location: primeIcon('map-marker'),
  journey: primeIcon('globe'), // PrimeIcons has no plane
  tag: primeIcon('hashtag'),
}

export interface TagLook {
  colour: string
  icon: Icon
  /** The kind's icon, drawn when `icon` cannot be. */
  fallback: SetIcon
}

/** The look a new top-level tag starts with: a random preset colour and its kind's icon. */
export function newTagLook(
  kind: TagKind,
  random: () => number = Math.random,
): { colour: string; icon: Icon } {
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
  const { colour, icon, fallback } = lookFrom(tag, tag.kind, tag.id, byId)
  return { colour, icon, fallback }
}

/** A look with the tags its colour and icon come from; null = the default. */
export interface InheritedLook extends TagLook {
  colourFrom: Tag | null
  iconFrom: Tag | null
}

/**
 * What a tag of `kind` that sets neither colour nor icon shows under
 * `parentId` (null: at the top level), and which tags that comes from — for
 * showing an inherited look as derived. `selfId` is the tag's own id (null
 * for a new one); the default colour of a top-level tag is picked by it.
 */
export function inheritedLook(
  kind: TagKind,
  parentId: ShortId | null,
  selfId: ShortId | null,
  byId: ReadonlyMap<ShortId, Tag>,
): InheritedLook {
  return lookFrom(parentId === null ? undefined : byId.get(parentId), kind, selfId ?? '', byId)
}

/** The first colour and icon set on the way up from `start`; defaults by `kind` and the topmost id reached. */
function lookFrom(
  start: Tag | undefined,
  kind: TagKind,
  topId: string,
  byId: ReadonlyMap<ShortId, Tag>,
): InheritedLook {
  let colourFrom: Tag | null = null
  let iconFrom: Tag | null = null
  let top = topId
  // Sync can leave a parent loop until it is repaired; never walk one twice.
  const seen = new Set<ShortId>()
  for (let current = start; current && !seen.has(current.id); ) {
    seen.add(current.id)
    top = current.id
    if (colourFrom === null && current.colour !== null) colourFrom = current
    if (iconFrom === null && current.icon !== null) iconFrom = current
    if (colourFrom !== null && iconFrom !== null) break
    current = current.parent_id === null ? undefined : byId.get(current.parent_id)
  }
  return {
    colour: colourFrom?.colour ?? COLOUR_PRESETS[stringHash(top) % COLOUR_PRESETS.length]!,
    icon: iconFrom?.icon ?? KIND_ICONS[kind],
    fallback: KIND_ICONS[kind],
    colourFrom,
    iconFrom,
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
