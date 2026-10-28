<script setup lang="ts">
/**
 * Names as outlined pills (an outline, unlike the filled TagChip), in a list
 * that screen readers announce by `label`. The caller sets its display and
 * renders it only when there are names. Wrapped by default; `oneLine` keeps
 * each pill whole and cuts the list at its edge.
 */
defineProps<{
  names: readonly string[]
  label: string
  oneLine?: boolean
}>()
</script>

<template>
  <ul
    :aria-label="label"
    class="gap-1"
    :class="oneLine ? 'min-w-0 items-center overflow-hidden' : 'flex-wrap'"
  >
    <li
      v-for="(name, i) in names"
      :key="i"
      class="rounded border border-gray-300 px-1.5 text-xs text-gray-600 dark:border-gray-600 dark:text-gray-300"
      :class="oneLine ? 'shrink-0 whitespace-nowrap' : 'max-w-full break-words'"
    >
      {{ name }}
    </li>
  </ul>
</template>
