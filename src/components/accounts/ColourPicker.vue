<script setup lang="ts">
import { computed } from 'vue'
import { COLOUR_PRESETS, COLOUR_PRESET_NAMES } from '@/format/colours'

/** The selected colour, '#rrggbb'. */
const colour = defineModel<string>({ required: true })

// <input type="color"> only accepts #rrggbb; a short #rgb stored elsewhere shows as black.
const pickerValue = computed(() =>
  /^#[0-9a-f]{6}$/i.test(colour.value) ? colour.value : '#000000',
)
const isCustom = computed(
  () => !(COLOUR_PRESETS as readonly string[]).includes(colour.value.toLowerCase()),
)

// Selected swatches get the primary ring, the others a grey one on hover.
const swatchRing = (selected: boolean) =>
  selected
    ? 'ring-2 ring-(--p-primary-color)'
    : 'hover:ring-2 hover:ring-gray-300 dark:hover:ring-gray-600'
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <button
      v-for="preset in COLOUR_PRESETS"
      :key="preset"
      type="button"
      class="size-8 rounded-full ring-offset-2 ring-offset-white transition-shadow dark:ring-offset-gray-900"
      :class="swatchRing(colour.toLowerCase() === preset)"
      :style="{ backgroundColor: preset }"
      :aria-label="COLOUR_PRESET_NAMES[preset]"
      :aria-pressed="colour.toLowerCase() === preset"
      @click="colour = preset"
    />
    <!-- Shows the picked colour when it is not a preset. -->
    <label
      class="relative flex size-8 cursor-pointer items-center justify-center rounded-full border border-dashed border-gray-400 ring-offset-2 ring-offset-white transition-shadow dark:ring-offset-gray-900"
      :class="swatchRing(isCustom)"
      :style="isCustom ? { backgroundColor: colour } : undefined"
      title="Custom colour"
    >
      <span v-if="!isCustom" class="pi pi-palette text-sm" aria-hidden="true" />
      <input
        type="color"
        class="absolute inset-0 size-full cursor-pointer opacity-0"
        aria-label="Custom colour"
        :value="pickerValue"
        @input="colour = ($event.target as HTMLInputElement).value"
      />
    </label>
  </div>
</template>
