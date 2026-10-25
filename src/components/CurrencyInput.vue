<script setup lang="ts">
import { ref } from 'vue'
import AutoComplete, { type AutoCompleteCompleteEvent } from 'primevue/autocomplete'
import { currencyName, currencySuggestions, currencySymbol } from '@/format/currency'

/**
 * A currency code, typed freely (custom codes like BTC are fine) or picked from
 * suggestions that show each code's symbol and name. Other attributes and
 * listeners (input-id, invalid, @show, @blur, …) go to the AutoComplete.
 */
const code = defineModel<string>({ required: true })
const props = withDefaults(defineProps<{ preferred?: readonly string[] }>(), {
  preferred: () => [],
})

const options = ref<string[]>([])
function complete(event: AutoCompleteCompleteEvent) {
  options.value = currencySuggestions(event.query, props.preferred)
}
</script>

<template>
  <AutoComplete v-model="code" :suggestions="options" dropdown @complete="complete">
    <template #option="{ option }">
      <span class="flex w-full min-w-0 items-center gap-3">
        <span class="w-12 shrink-0 font-medium">{{ option }}</span>
        <span class="w-6 shrink-0 text-center">{{ currencySymbol(option) }}</span>
        <span class="truncate text-sm text-gray-500 dark:text-gray-400">
          {{ currencyName(option) }}
        </span>
      </span>
    </template>
  </AutoComplete>
</template>
