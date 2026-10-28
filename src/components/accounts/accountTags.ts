import type { ShortId } from '@/db/shortId'
import type { Tag } from '@/db/types'
import { effectiveLook, type TagLook } from '@/tags/look'
import { foldCase } from '@/tags/otherNames'
import { pathLabel, tagPath } from '@/tags/tree'

// An account's plain tags as the Accounts page and the account dialog show
// them, kept out of the components so they can be tested without mounting.

/** One of an account's tags as a chip on its row. */
export interface AccountTagChip extends TagLook {
  id: ShortId
  /** Its path, e.g. 'family › mia'. */
  label: string
  /** Still on the account, but no longer offered: drawn faint. */
  archived: boolean
}

/** The chips for an account's tag ids, in their order: deleted and unknown tags are left out. */
export function accountTagChips(
  ids: readonly ShortId[],
  byId: ReadonlyMap<ShortId, Tag>,
): AccountTagChip[] {
  return ids.flatMap((id) => {
    const tag = byId.get(id)
    if (!tag || tag.deleted_at_utc !== null) return []
    return [
      {
        id,
        label: pathLabel(tagPath(tag, byId)),
        ...effectiveLook(tag, byId),
        archived: tag.archived_at_utc !== null,
      },
    ]
  })
}

/**
 * The plain tag a name in the account dialog stands for, as saving finds it
 * (`useTagsStore().resolvePlainTags`): one of the `known` tags (the
 * account's, and those picked from the suggestions) with that main name,
 * else with it as a synonym; else the oldest live plain tag with that main
 * name, then with it as a synonym, then carrying it from a merged tag
 * (`merged`: `mergedNamesByTag`). Undefined: saving makes a new tag.
 */
export function tagForName(
  name: string,
  known: readonly ShortId[],
  tags: readonly Tag[],
  merged: ReadonlyMap<ShortId, readonly string[]>,
): Tag | undefined {
  const key = foldCase(name.trim())
  const named = (t: Tag) => foldCase(t.name) === key
  const aka = (names: readonly string[]) => names.some((n) => foldCase(n) === key)
  const plain = tags.filter((t) => t.kind === 'tag')
  const own = known.flatMap((id) => plain.filter((t) => t.id === id))
  const live = plain
    .filter((t) => t.deleted_at_utc === null)
    .sort(
      (a, b) => a.created_at_utc.getTime() - b.created_at_utc.getTime() || (a.id < b.id ? -1 : 1),
    )
  return (
    own.find(named) ??
    own.find((t) => aka(t.synonyms)) ??
    live.find(named) ??
    live.find((t) => aka(t.synonyms)) ??
    live.find((t) => aka(merged.get(t.id) ?? []))
  )
}
