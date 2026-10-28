import type { AccountGrouping } from '@/db/types'
import type { AccountGroupingUpdateInput } from '@/db/repositories/AccountGroupingsRepository'
import { COLOUR_PRESETS } from '@/format/colours'
import { primeIcon } from '@/icons/sets'
import { sameIcon, type Icon } from '@/icons/types'

// Form logic of the group editor, kept out of the component like accountForm.

/** A group's default icon: what a new one starts with, and what one shows when its own cannot be drawn. */
export const GROUPING_ICON = primeIcon('folder')

export interface GroupingDraft {
  name: string
  icon: Icon
  colour: string
}

/** Draft for a new group: the folder icon and the next palette colour. */
export function newGroupingDraft(existing: readonly AccountGrouping[]): GroupingDraft {
  return {
    name: '',
    icon: GROUPING_ICON,
    colour: COLOUR_PRESETS[existing.length % COLOUR_PRESETS.length]!,
  }
}

export function draftFromGrouping(grouping: AccountGrouping): GroupingDraft {
  return { name: grouping.name, icon: grouping.icon, colour: grouping.colour }
}

export function validateGroupingDraft(draft: GroupingDraft): { name?: string } {
  return draft.name.trim() === '' ? { name: 'Give the group a name.' } : {}
}

/** The draft as saved: the name trimmed. */
export function normaliseGroupingDraft(draft: GroupingDraft): GroupingDraft {
  return { ...draft, name: draft.name.trim() }
}

/** Only the fields that changed, so an untouched save writes nothing. */
export function groupingPatchFromDraft(
  grouping: AccountGrouping,
  draft: GroupingDraft,
): AccountGroupingUpdateInput {
  const patch: AccountGroupingUpdateInput = {}
  if (draft.name !== grouping.name) patch.name = draft.name
  if (!sameIcon(draft.icon, grouping.icon)) patch.icon = draft.icon
  if (draft.colour !== grouping.colour) patch.colour = draft.colour
  return patch
}
