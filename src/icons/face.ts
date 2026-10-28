import type { ImageView } from '@/stores/images'
import { emojiTints, iconColourOn } from './colours'
import { setIconClass } from './sets'
import type { Icon, SetIcon } from './types'

// What a badge shows for an icon (docs/plans/2026-10-28-icons-design.md §4),
// worked out once for the Vue badge (IconBadge.vue) and the map pins'
// DOM element (badgeElement.ts).

export type BadgeFace =
  /** A pack icon in a readable colour on the colour. */
  | { kind: 'glyph'; className: string; background: string; foreground: string }
  /** An emoji on a tint of the colour, one per theme. */
  | { kind: 'emoji'; emoji: string; tints: { light: string; dark: string } }
  /**
   * A picture on a neutral background with the colour as a thin ring; a word
   * (`fills`) covers the circle with its own background, an upload is inset
   * to stay clear of the curve.
   */
  | { kind: 'image'; url: string; fills: boolean; ring: string }

/** Used only if the default icon itself is unknown, which would be a bug. */
const LAST_RESORT_CLASS = 'pi pi-circle'

/**
 * The face of a badge for `icon` in `colour`. `image` is the image of an
 * image icon as the images store holds it: undefined while it loads, null
 * when it is missing. An icon that cannot be drawn — an unknown kind or pack
 * icon, an image that is loading or missing — shows `fallback`, its owner's
 * default icon.
 */
export function badgeFace(
  icon: Icon,
  colour: string,
  fallback: SetIcon,
  image?: ImageView | null,
): BadgeFace {
  if (icon.kind === 'emoji') return { kind: 'emoji', emoji: icon.emoji, tints: emojiTints(colour) }
  if (icon.kind === 'image' && image) {
    return { kind: 'image', url: image.url, fills: image.fills, ring: colour }
  }
  const className =
    (icon.kind === 'set' ? setIconClass(icon) : null) ?? setIconClass(fallback) ?? LAST_RESORT_CLASS
  return { kind: 'glyph', className, background: colour, foreground: iconColourOn(colour) }
}

// Tailwind classes shared by both renderings (Tailwind finds them in this file).

/** The emoji disc: the theme picks the tint from the custom properties. */
export const EMOJI_DISC_CLASS = 'bg-(--tint-light) dark:bg-(--tint-dark)'
/** The picture disc: white in both themes (logos are made for it), ringed by its border. */
export const IMAGE_DISC_CLASS = 'bg-white'
/** The picture fills the disc, keeping its proportions. */
export const IMAGE_CLASS = 'size-full object-contain'
/** An upload sits inside the circle; a word fills it. */
export const INSET_IMAGE_CLASS = 'p-[15%]'
