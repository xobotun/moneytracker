import type { ShortId } from '@/db/shortId'
import type { Tag, TagDetailValues, TagKind } from '@/db/types'
import type { TagCreateInput, TagSaveInput } from '@/db/repositories/TagsRepository'
import { newTagLook } from '@/tags/look'
import { cleanOtherNames } from '@/tags/otherNames'

// Form logic of the tag editor, kept out of the component so it can be tested
// without mounting PrimeVue.

/** What the editor edits; the detail fields of other kinds stay empty. */
export interface TagDraft {
  name: string
  parent_id: ShortId | null
  /** Synonyms, then merged names (src/tags/otherNames.ts). */
  otherNames: string[]
  description: string
  colour: string | null // null = inherited
  icon: string | null // null = inherited
  address: string
  latitude: number | null
  longitude: number | null
  merchant_id: ShortId | null
  default_category_id: ShortId | null
  start_date: string | null // 'YYYY-MM-DD'; null = derived from the journey's transactions
  end_date: string | null
}

export interface TagDraftErrors {
  name?: string
  position?: string
  dates?: string
}

/** The singular word for a kind, as headings and buttons use it. */
export const KIND_NOUNS: Record<TagKind, string> = {
  category: 'category',
  merchant: 'merchant',
  location: 'location',
  journey: 'journey',
  tag: 'tag',
}

/**
 * A new tag under `parentId`: a top-level one starts with a random preset
 * colour and its kind's icon (decisions §2.1), a child inherits both.
 */
export function newTagDraft(
  kind: TagKind,
  parentId: ShortId | null,
  random: () => number = Math.random,
): TagDraft {
  const look = parentId === null ? newTagLook(kind, random) : { colour: null, icon: null }
  return {
    name: '',
    parent_id: parentId,
    otherNames: [],
    description: '',
    colour: look.colour,
    icon: look.icon,
    address: '',
    latitude: null,
    longitude: null,
    merchant_id: null,
    default_category_id: null,
    start_date: null,
    end_date: null,
  }
}

type DetailDraft = Pick<
  TagDraft,
  | 'address'
  | 'latitude'
  | 'longitude'
  | 'merchant_id'
  | 'default_category_id'
  | 'start_date'
  | 'end_date'
>

/** The detail fields of a draft (they are read after the tag's own fields). */
export function detailDraft(details: TagDetailValues): DetailDraft {
  return {
    address: details.address ?? '',
    latitude: details.position?.latitude ?? null,
    longitude: details.position?.longitude ?? null,
    merchant_id: details.merchant_id,
    default_category_id: details.default_category_id,
    start_date: details.start_date,
    end_date: details.end_date,
  }
}

/** The draft of a stored tag; `merged`: its merged names. */
export function draftFromTag(
  tag: Tag,
  details: TagDetailValues,
  merged: readonly string[],
): TagDraft {
  return {
    name: tag.name,
    parent_id: tag.parent_id,
    otherNames: [...tag.synonyms, ...merged],
    description: tag.description ?? '',
    colour: tag.colour,
    icon: tag.icon,
    ...detailDraft(details),
  }
}

/** What is wrong with a typed position: both coordinates or neither, each in range. */
export function positionError(
  latitude: number | null,
  longitude: number | null,
): string | undefined {
  if ((latitude === null) !== (longitude === null)) return 'Enter both coordinates or neither.'
  if (
    latitude !== null &&
    longitude !== null &&
    (Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
  ) {
    return 'Latitude goes from −90 to 90, longitude from −180 to 180.'
  }
  return undefined
}

export function validateDraft(draft: TagDraft): TagDraftErrors {
  const errors: TagDraftErrors = {}
  if (draft.name.trim() === '') errors.name = 'Give the tag a name.'
  const position = positionError(draft.latitude, draft.longitude)
  if (position) errors.position = position
  if (draft.start_date !== null && draft.end_date !== null && draft.start_date > draft.end_date) {
    errors.dates = 'The journey cannot end before it starts.'
  }
  return errors
}

function detailsFromDraft(draft: TagDraft): TagDetailValues {
  const { latitude, longitude } = draft
  return {
    address: draft.address.trim() || null,
    position: latitude !== null && longitude !== null ? { latitude, longitude } : null,
    merchant_id: draft.merchant_id,
    default_category_id: draft.default_category_id,
    start_date: draft.start_date,
    end_date: draft.end_date,
  }
}

export function saveInputFromDraft(draft: TagDraft): TagSaveInput {
  return {
    name: draft.name.trim(),
    parent_id: draft.parent_id,
    description: draft.description.trim() || null,
    otherNames: draft.otherNames,
    colour: draft.colour,
    icon: draft.icon,
    details: detailsFromDraft(draft),
  }
}

export function createInputFromDraft(kind: TagKind, draft: TagDraft): TagCreateInput {
  const name = draft.name.trim()
  return {
    kind,
    name,
    parent_id: draft.parent_id,
    description: draft.description.trim() || null,
    synonyms: cleanOtherNames(name, draft.otherNames),
    colour: draft.colour,
    icon: draft.icon,
    details: detailsFromDraft(draft),
  }
}
