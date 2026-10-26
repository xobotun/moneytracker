import type { AccountGrouping } from '@/db/types'
import type { AccountGroupingUpdateInput } from '@/db/repositories/AccountGroupingsRepository'
import { COLOUR_PRESETS } from '@/format/colours'

// Form logic of the group editor, kept out of the component like accountForm.

export interface GroupingDraft {
  name: string
  icon: string
  colour: string
}

/** Draft for a new group: the folder icon and the next palette colour. */
export function newGroupingDraft(existing: readonly AccountGrouping[]): GroupingDraft {
  return {
    name: '',
    icon: 'folder',
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
  if (draft.icon !== grouping.icon) patch.icon = draft.icon
  if (draft.colour !== grouping.colour) patch.colour = draft.colour
  return patch
}
