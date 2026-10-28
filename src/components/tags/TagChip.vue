<script setup lang="ts">
import { accountIconClass } from '@/components/accounts/accountForm'

/**
 * A tag as a filled chip: its icon in its colour, then its label (a name or
 * a path). In a row the caller sets its display — `flex`, or a responsive
 * pair — so that no two display classes meet on one element, and a long
 * label is cut. `inText` makes it flow and wrap like the words around it,
 * so punctuation after it stays on its last line.
 */
defineProps<{
  label: string
  icon: string
  colour: string
  /** Struck through, with “(deleted)” after it. */
  deleted?: boolean
  /** Read before the icon by screen readers only, e.g. 'merchant: '. */
  srPrefix?: string
  inText?: boolean
}>()
</script>

<template>
  <span
    class="min-w-0 items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-white/10 dark:text-gray-200"
    :class="inText ? 'inline box-decoration-clone break-words' : undefined"
  >
    <span v-if="srPrefix" class="sr-only">{{ srPrefix }}</span>
    <span
      :class="[accountIconClass(icon), inText ? 'mr-1' : undefined]"
      class="text-[0.7rem]"
      :style="{ color: colour }"
      aria-hidden="true"
    />
    <!-- No spaces around the label: in text they would show inside the chip. -->
    <span :class="[inText ? undefined : 'truncate', deleted ? 'line-through' : undefined]">{{
      label
    }}</span>
    <span v-if="deleted" class="shrink-0">{{ ' (deleted)' }}</span>
  </span>
</template>
