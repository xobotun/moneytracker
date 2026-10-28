import { asShortId, type ShortId } from '@/db/shortId'
import type { Tag } from '@/db/types'

const AT = new Date('2026-10-26T00:00:00.000Z')

/** A live top-level category called `id`, with `over` applied. */
export function tag(id: string, over: Partial<Tag> = {}): Tag {
  return {
    id: asShortId(id),
    kind: 'category',
    name: id,
    parent_id: null,
    moved_at_utc: AT,
    description: null,
    synonyms: [],
    retired_names: [],
    colour: null,
    icon: null,
    merged_into_id: null,
    archived_at_utc: null,
    created_at_utc: AT,
    updated_at_utc: AT,
    deleted_at_utc: null,
    ...over,
  }
}

/** `tag()` merged into `into` (deleted then). */
export function merged(id: string, into: string, over: Partial<Tag> = {}): Tag {
  return tag(id, { merged_into_id: asShortId(into), deleted_at_utc: AT, ...over })
}

export function byId(...tags: Tag[]): Map<ShortId, Tag> {
  return new Map(tags.map((t) => [t.id, t]))
}
