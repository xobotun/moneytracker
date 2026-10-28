<script setup lang="ts">
import { ref } from 'vue'
import AutoComplete from 'primevue/autocomplete'
import { foldCase } from '@/tags/otherNames'

/**
 * Short texts typed as chips: type one and press Enter. Text still typed
 * when the field loses focus becomes a chip too (pressing Save blurs it
 * first), so a forgotten Enter loses nothing: trimmed, an empty one dropped,
 * and one the list already has, ignoring case, not added again. `commit()`
 * does the same on demand: a form calls it before it saves. Other attributes
 * and listeners (input-id, fluid, pt, …) go to the AutoComplete.
 */
const chips = defineModel<string[]>({ required: true })
const field = ref<{ $el: HTMLElement } | null>(null)

function commit(): void {
  const input = field.value?.$el.querySelector('input')
  if (!input) return
  const text = input.value.trim()
  input.value = ''
  if (text === '' || chips.value.some((chip) => foldCase(chip) === foldCase(text))) return
  chips.value = [...chips.value, text]
}

defineExpose({ commit })
</script>

<template>
  <AutoComplete ref="field" v-model="chips" multiple :typeahead="false" @blur="commit" />
</template>
