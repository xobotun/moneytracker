<script setup lang="ts">
import { accountIconClass } from '@/components/accounts/accountForm'
import type { TagLook } from '@/tags/look'

/**
 * A tag picker's option, or its picked value: the tag's icon in its colour,
 * then its label. An option that is no tag ('None') has no icon; with no
 * option, the placeholder. The Select names the option to screen readers.
 */
defineProps<{
  option?: { label: string } & Partial<TagLook>
  placeholder?: string
}>()
</script>

<template>
  <span class="flex min-w-0 items-center gap-2">
    <span
      v-if="option?.icon"
      :class="accountIconClass(option.icon)"
      class="shrink-0"
      :style="{ color: option.colour }"
      aria-hidden="true"
    />
    <span class="truncate">{{ option?.label ?? placeholder }}</span>
  </span>
</template>
