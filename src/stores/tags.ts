import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getTagsRepository } from '@/db/init'
import type { ShortId } from '@/db/shortId'
import type { Tag } from '@/db/types'
import { newTagLook } from '@/tags/look'

/**
 * Tags of every kind, read from SQLite (the source of truth) and re-read after
 * each write. Pages show a tag by id through `nameOf`, so a rename shows up
 * everywhere after the next `load()`.
 */
export const useTagsStore = defineStore('tags', () => {
  const tags = ref<Tag[]>([])

  const byId = computed(() => new Map<ShortId, Tag>(tags.value.map((t) => [t.id, t])))

  async function load(): Promise<void> {
    tags.value = await getTagsRepository().listAll()
  }

  /** The tag's name; callers hide deleted tags (`deleted_at_utc !== null`). */
  function nameOf(id: ShortId): string {
    return byId.value.get(id)?.name ?? ''
  }

  /**
   * The ids of the top-level plain tags called `names` (or having one of them
   * as a synonym): missing ones are created. Names are trimmed, empty ones
   * ignored; the result keeps first-occurrence order without duplicate ids.
   */
  async function resolvePlainTags(names: readonly string[]): Promise<ShortId[]> {
    const repo = getTagsRepository()
    const ids: ShortId[] = []
    for (const raw of names) {
      const name = raw.trim()
      if (name === '') continue
      const found =
        (await repo.findByName('tag', name, null)) ??
        (await repo.create({ kind: 'tag', name, parent_id: null, ...newTagLook('tag') }))
      if (!ids.includes(found.id)) ids.push(found.id)
    }
    await load()
    return ids
  }

  return { tags, byId, load, nameOf, resolvePlainTags }
})
