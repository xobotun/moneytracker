<script setup lang="ts">
import IconBadge from '@/components/icons/IconBadge.vue'
import type { Icon, SetIcon } from '@/icons/types'

/**
 * A tag as a filled chip: its icon in its colour, then its label (a name or
 * a path). In a row the caller sets its display — `flex`, or a responsive
 * pair — so that no two display classes meet on one element, and a long
 * label is cut. `inText` makes it flow and wrap like the words around it,
 * so punctuation after it stays on its last line. `outlined` draws it with
 * an outline instead of the fill, for what is not a tag (an account's group
 * next to its tags).
 */
defineProps<{
  label: string
  icon: Icon
  colour: string
  /** The tag's kind icon, drawn when `icon` cannot be. */
  fallback: SetIcon
  /** Struck through, with “(deleted)” after it. */
  deleted?: boolean
  /** Read before the icon by screen readers only, e.g. 'merchant: '. */
  srPrefix?: string
  inText?: boolean
  outlined?: boolean
}>()
</script>

<template>
  <span
    class="min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-gray-700 dark:text-gray-200"
    :class="[
      inText ? 'inline box-decoration-clone break-words' : undefined,
      outlined
        ? 'ring-1 ring-gray-300 ring-inset dark:ring-gray-600'
        : 'bg-gray-100 dark:bg-white/10',
    ]"
  >
    <span v-if="srPrefix" class="sr-only">{{ srPrefix }}</span>
    <IconBadge
      inline
      :icon="icon"
      :colour="colour"
      :fallback="fallback"
      class="text-[0.7rem]"
      :class="inText ? 'mr-1 align-[-0.2em]' : undefined"
    />
    <!-- No spaces around the label: in text they would show inside the chip. -->
    <span :class="[inText ? undefined : 'truncate', deleted ? 'line-through' : undefined]">{{
      label
    }}</span>
    <span v-if="deleted" class="shrink-0">{{ ' (deleted)' }}</span>
  </span>
</template>
