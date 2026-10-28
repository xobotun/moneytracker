import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getTagDetailsRepository, getTagsRepository } from '@/db/init'
import type { ShortId } from '@/db/shortId'
import type { Tag, TagDetailConflict, TagDetailValues } from '@/db/types'
import type { TagCreateInput, TagSaveInput } from '@/db/repositories/TagsRepository'
import type { JourneyDates } from '@/db/repositories/TagDetailsRepository'
import { newTagLook } from '@/tags/look'
import { foldCase } from '@/tags/otherNames'

/**
 * Tags of every kind, read from SQLite (the source of truth) and re-read after
 * each write. Pages look a tag up by id in `byId` (deleted and merged ones
 * included, so they can hide those), so a rename shows up everywhere after the
 * next `load()`.
 *
 * Write-through: every change is persisted first and the tags are then
 * re-read, so the state never shows something the database does not hold. A
 * failed write rethrows and leaves the state as it was.
 */
export const useTagsStore = defineStore('tags', () => {
  const tags = ref<Tag[]>([])
  const loaded = ref(false)
  /** The live tags that share a kind, a parent and a name with another one (see `duplicates()`). */
  const duplicateIds = ref<ReadonlySet<ShortId>>(new Set())
  /** The details of every tag that has any, by tag id (for lists; dialogs read their own). */
  const detailsById = ref<ReadonlyMap<ShortId, TagDetailValues>>(new Map())
  /** Every live journey's dates, typed or derived, by id (read in one query). */
  const journeyDatesById = ref<ReadonlyMap<ShortId, JourneyDates>>(new Map())
  /** Each merchant's default category and each location's merchant, by tag id. */
  const detailLinks = computed(() => {
    const links = new Map<ShortId, ShortId>()
    for (const [id, values] of detailsById.value) {
      const link = values.default_category_id ?? values.merchant_id
      if (link !== null) links.set(id, link)
    }
    return links
  })

  const byId = computed(() => new Map<ShortId, Tag>(tags.value.map((t) => [t.id, t])))

  async function load(): Promise<void> {
    const repo = getTagsRepository()
    const details = getTagDetailsRepository()
    const [all, groups, byTag, dates] = await Promise.all([
      repo.listAll(),
      repo.duplicates(),
      details.detailsByTag(),
      details.allJourneyDates(),
    ])
    tags.value = all
    duplicateIds.value = new Set(groups.flat())
    detailsById.value = byTag
    journeyDatesById.value = dates
    loaded.value = true
  }

  /** The tag's name; callers hide deleted tags (`deleted_at_utc !== null`). */
  function nameOf(id: ShortId): string {
    return byId.value.get(id)?.name ?? ''
  }

  /**
   * The ids of the plain tags called `names` (by a name or a synonym). The
   * `known` tags (those the account already has) come first, wherever they
   * sit: a name keeps every known tag with that main name (two at different
   * levels show as one chip), else the first known tag with it as a synonym.
   * Any other name is looked up at any level, and a name found nowhere
   * becomes a new top-level tag. Names are trimmed, empty ones ignored; the
   * result keeps first-occurrence order without duplicate ids.
   */
  async function resolvePlainTags(
    names: readonly string[],
    known: readonly ShortId[] = [],
  ): Promise<ShortId[]> {
    const repo = getTagsRepository()
    const own = (await Promise.all(known.map((id) => repo.findById(id)))).filter(
      (tag): tag is Tag => tag !== null && tag.kind === 'tag',
    )
    const ids: ShortId[] = []
    for (const raw of names) {
      const name = raw.trim()
      if (name === '') continue
      const key = foldCase(name)
      const named = own.filter((tag) => foldCase(tag.name) === key)
      const bySynonym = own.find((tag) => tag.synonyms.some((s) => foldCase(s) === key))
      const found =
        named.length > 0
          ? named
          : [
              bySynonym ??
                (await repo.findByName('tag', name)) ??
                (await repo.create({ kind: 'tag', name, parent_id: null, ...newTagLook('tag') })),
            ]
      for (const tag of found) if (!ids.includes(tag.id)) ids.push(tag.id)
    }
    await load()
    return ids
  }

  async function create(input: TagCreateInput): Promise<Tag> {
    const tag = await getTagsRepository().create(input)
    await load()
    return tag
  }

  /** Ends the journey under way and starts the next one beside it (`TagsRepository.continueJourney`). */
  async function continueJourney(
    currentId: ShortId,
    input: Omit<TagCreateInput, 'kind' | 'parent_id'>,
  ): Promise<Tag> {
    const tag = await getTagsRepository().continueJourney(currentId, input)
    await load()
    return tag
  }

  async function save(id: ShortId, input: TagSaveInput): Promise<void> {
    await getTagsRepository().save(id, input)
    await load()
  }

  async function merge(
    sourceId: ShortId,
    targetId: ShortId,
    resolved?: Partial<TagDetailValues>,
  ): Promise<void> {
    await getTagsRepository().merge(sourceId, targetId, resolved)
    await load()
  }

  async function remove(id: ShortId): Promise<void> {
    await getTagsRepository().softDelete(id)
    await load()
  }

  async function restore(id: ShortId): Promise<void> {
    await getTagsRepository().restore(id)
    await load()
  }

  /** Stops offering the tag in pickers; it stays on what uses it (see `TagsRepository.archive`). */
  async function archive(id: ShortId): Promise<void> {
    await getTagsRepository().archive(id)
    await load()
  }

  async function unarchive(id: ShortId): Promise<void> {
    await getTagsRepository().unarchive(id)
    await load()
  }

  function usageCount(id: ShortId): Promise<number> {
    return getTagsRepository().usageCount(id)
  }

  function detailConflicts(sourceId: ShortId, targetId: ShortId): Promise<TagDetailConflict[]> {
    return getTagsRepository().detailConflicts(sourceId, targetId)
  }

  function details(tag: Tag): Promise<TagDetailValues> {
    return getTagDetailsRepository().values(tag.id, tag.kind)
  }

  function journeyDates(id: ShortId) {
    return getTagDetailsRepository().journeyDates(id)
  }

  return {
    tags,
    loaded,
    duplicateIds,
    detailsById,
    journeyDatesById,
    detailLinks,
    byId,
    load,
    nameOf,
    resolvePlainTags,
    create,
    continueJourney,
    save,
    merge,
    remove,
    restore,
    archive,
    unarchive,
    usageCount,
    detailConflicts,
    details,
    journeyDates,
  }
})
