import type { UUID } from '@/db/uuid'

// An icon is a small typed value (docs/plans/2026-10-28-icons-design.md §2),
// stored as a JSON object in the `icon` columns of tags, accounts and account
// groups. Drawing knows three kinds; anything else is kept, never dropped.

/** An icon from a pack registered in code (`ICON_SETS`), e.g. PrimeIcons' `shop`. */
export interface SetIcon {
  readonly kind: 'set'
  readonly set: string
  readonly name: string
}

/** An emoji, as each device's system draws it. */
export interface EmojiIcon {
  readonly kind: 'emoji'
  readonly emoji: string
}

/** A picture from the `images` table: an upload, or a word made in the Text tab. */
export interface ImageIcon {
  readonly kind: 'image'
  readonly image: UUID
}

/**
 * A stored icon this build cannot read — a kind or a shape from a newer app.
 * It keeps its JSON text, so saving writes it back unchanged, and it draws as
 * the owner's default icon.
 */
export interface UnknownIcon {
  readonly kind: 'unknown'
  readonly json: string
}

export type Icon = SetIcon | EmojiIcon | ImageIcon | UnknownIcon

export const setIcon = (set: string, name: string): SetIcon => ({ kind: 'set', set, name })
export const emojiIcon = (emoji: string): EmojiIcon => ({ kind: 'emoji', emoji })
export const imageIcon = (image: UUID): ImageIcon => ({ kind: 'image', image })

/**
 * The icon as JSON text, keys in a fixed order: the same icon is always the
 * same text (the database hash and the CSV compare it). An unknown icon is
 * its text as read.
 */
export function iconToJson(icon: Icon): string {
  switch (icon.kind) {
    case 'set':
      return JSON.stringify({ kind: 'set', set: icon.set, name: icon.name })
    case 'emoji':
      return JSON.stringify({ kind: 'emoji', emoji: icon.emoji })
    case 'image':
      return JSON.stringify({ kind: 'image', image: icon.image })
    case 'unknown':
      return icon.json
  }
}

/** Whether `value` has exactly the keys `kind` and `fields`, each a non-empty string. */
function hasExactly(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = ['kind', ...fields]
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => typeof value[key] === 'string' && value[key] !== '')
  )
}

/**
 * Reads an icon from its JSON text. Only an object with exactly the fields of
 * a known kind is that kind; anything else — another kind, a field more or
 * less, not JSON at all — is an `UnknownIcon` holding `text` verbatim.
 */
export function iconFromJson(text: string): Icon {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'unknown', json: text }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>
    if (v.kind === 'set' && hasExactly(v, ['set', 'name'])) {
      return setIcon(v.set as string, v.name as string)
    }
    if (v.kind === 'emoji' && hasExactly(v, ['emoji'])) return emojiIcon(v.emoji as string)
    if (v.kind === 'image' && hasExactly(v, ['image'])) return imageIcon(v.image as UUID)
  }
  return { kind: 'unknown', json: text }
}

/** Whether two icons are the same (compared as stored); null is "inherited". */
export function sameIcon(a: Icon | null, b: Icon | null): boolean {
  if (a === null || b === null) return a === b
  return iconToJson(a) === iconToJson(b)
}
