<script setup lang="ts">
import { ref } from 'vue'
import AutoComplete, { type AutoCompleteProps } from 'primevue/autocomplete'
import Chip from 'primevue/chip'
import IconBadge from '@/components/icons/IconBadge.vue'
import TagOptionLabel from '@/components/tags/TagOptionLabel.vue'
import type { TagLook } from '@/tags/look'
import { foldCase } from '@/tags/otherNames'
import type { TagSuggestion } from '@/tags/tree'

/**
 * Short texts typed as chips: type one and press Enter. Text still typed
 * when the field loses focus becomes a chip too (pressing Save blurs it
 * first), so a forgotten Enter loses nothing: trimmed, an empty one dropped,
 * and one the list already has, ignoring case, not added again. `commit()`
 * does the same on demand: a form calls it before it saves. Other attributes
 * and listeners (input-id, fluid, pt, @show, …) go to the AutoComplete.
 *
 * With `suggest`, the text typed so far offers tags (by path, with their
 * icon); picking one adds its main name and emits `pick`. Enter still adds
 * the typed text when no suggestion is highlighted. With `chipLook`, a chip
 * that stands for a tag shows its icon in its colour; one it gives no look
 * (a new name) stays plain.
 */
defineOptions({ inheritAttrs: false })

const chips = defineModel<string[]>({ required: true })
const props = defineProps<{
  suggest?: (query: string) => TagSuggestion[]
  chipLook?: (chip: string) => TagLook | null
}>()
const emit = defineEmits<{ pick: [suggestion: TagSuggestion] }>()

// focusedMultipleOptionIndex: the chip highlighted with the arrow keys (AutoComplete's own state).
const field = ref<{ $el: HTMLElement; focusedMultipleOptionIndex?: number } | null>(null)
const options = ref<TagSuggestion[]>([])

const textInput = () => field.value?.$el.querySelector('input') ?? null

/** `names` trimmed, without empty ones, each once ignoring case (the first spelling stays). */
function distinct(names: readonly string[]): string[] {
  const kept: string[] = []
  for (const raw of names) {
    const text = raw.trim()
    if (text !== '' && !kept.some((chip) => foldCase(chip) === foldCase(text))) kept.push(text)
  }
  return kept
}

function commit(): void {
  const input = textInput()
  if (!input) return
  const next = distinct([...chips.value, input.value])
  input.value = ''
  if (next.length !== chips.value.length) chips.value = next
}

// What AutoComplete makes of the chips (Enter, a removed chip, a picked
// suggestion — added as the object itself; the chip is its name). Always a
// new list, even when nothing is added, so AutoComplete drops a repeat it
// showed.
function onUpdate(next: (string | TagSuggestion)[]): void {
  chips.value = distinct(next.map((value) => (typeof value === 'string' ? value : value.name)))
  for (const value of next) if (typeof value !== 'string') emit('pick', value)
}

function complete(): void {
  // The search waits a moment after typing: read the text as it is now, so
  // text that became a chip meanwhile offers nothing.
  const typed = textInput()?.value ?? ''
  options.value = props.suggest && typed.trim() !== '' ? props.suggest(typed) : []
}

// With suggestions on, AutoComplete's Enter only picks a highlighted one and
// would let the form submit: a name typed in full becomes a chip here (after
// AutoComplete's own handler, so a picked suggestion has cleared the text).
function onKeydown(event: KeyboardEvent): void {
  if (!props.suggest || event.key !== 'Enter' || event.isComposing) return
  if (event.target !== textInput()) return
  event.preventDefault()
  commit()
}

/**
 * The caller's pass-through options; with suggestions, plus: a press on a
 * suggestion keeps the focus in the input, so blurring does not first add
 * the half-typed text as a chip.
 */
function passThrough(pt: unknown): AutoCompleteProps['pt'] {
  if (!props.suggest) return pt as AutoCompleteProps['pt']
  const own = (pt ?? {}) as Record<string, unknown>
  const overlay = (own.overlay ?? {}) as Record<string, unknown>
  const keepFocus = (e: MouseEvent) => e.preventDefault()
  return { ...own, overlay: { ...overlay, onMousedown: keepFocus } }
}

const optionText = (option: string | TagSuggestion) =>
  typeof option === 'string' ? option : option.label

defineExpose({ commit })
</script>

<template>
  <AutoComplete
    ref="field"
    v-bind="$attrs"
    :model-value="chips"
    multiple
    :typeahead="suggest !== undefined"
    :suggestions="options"
    :option-label="suggest ? optionText : undefined"
    :show-empty-message="false"
    :pt="passThrough($attrs.pt)"
    @update:model-value="onUpdate"
    @complete="complete"
    @keydown="onKeydown"
    @blur="commit"
  >
    <template v-if="suggest" #option="{ option }">
      <TagOptionLabel :option="option" />
    </template>
    <template v-if="chipLook" #chip="{ value, index, removeCallback }">
      <Chip
        class="p-autocomplete-chip"
        :label="value"
        removable
        :data-p-focused="field?.focusedMultipleOptionIndex === index"
        @remove="removeCallback"
      >
        <template v-if="chipLook(value)" #default>
          <IconBadge inline v-bind="chipLook(value)!" data-chip-icon />
          <div class="p-chip-label">{{ value }}</div>
        </template>
      </Chip>
    </template>
  </AutoComplete>
</template>
