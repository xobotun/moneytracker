<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import IconBadge from '@/components/icons/IconBadge.vue'
import IconDialog from '@/components/icons/IconDialog.vue'
import { PRIME_ICON_SET, QUICK_ICONS, iconLabel, isPrimeIcon, primeIcon } from '@/icons/sets'
import type { Icon, SetIcon } from '@/icons/types'

/**
 * Quick picks of PrimeIcons, and a tile that opens the dialog with every
 * other way to choose an icon (IconDialog.vue). `colour` is the colour of the
 * owner the icon is for, `ownerNoun` what it is ("merchant", "account"),
 * `fallback` its default icon, drawn for a picked icon that cannot
 * be drawn. `open` tells the dialog underneath not to close on Escape while
 * the icon dialog is open: every open dialog hears it.
 */
defineProps<{ fallback: SetIcon; colour: string; ownerNoun: string }>()
const icon = defineModel<Icon>({ required: true })
const open = defineModel<boolean>('open', { default: false })

const moreButton = useTemplateRef<HTMLButtonElement>('moreButton')

const isQuick = computed(() => QUICK_ICONS.some((name) => isPrimeIcon(icon.value, name)))

const tileClass = (selected: boolean) =>
  selected
    ? 'border-(--p-primary-color) text-(--p-primary-color)'
    : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-800'
</script>

<template>
  <div class="flex flex-wrap gap-1">
    <button
      v-for="name in QUICK_ICONS"
      :key="name"
      type="button"
      class="flex size-10 items-center justify-center rounded-md border-2 transition-colors"
      :class="tileClass(isPrimeIcon(icon, name))"
      :aria-label="iconLabel(primeIcon(name))"
      :aria-pressed="isPrimeIcon(icon, name)"
      :title="iconLabel(primeIcon(name))"
      @click="icon = primeIcon(name)"
    >
      <span :class="PRIME_ICON_SET.className(name)" aria-hidden="true" />
    </button>
    <!-- Shows the picked icon when it is not one of the quick ones, like the
         custom colour swatch shows a custom colour. -->
    <button
      ref="moreButton"
      type="button"
      class="flex size-10 items-center justify-center rounded-md border-2 transition-colors"
      :class="
        isQuick
          ? 'border-dashed border-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
          : tileClass(true)
      "
      :aria-label="isQuick ? 'All icons' : `All icons, selected: ${iconLabel(icon)}`"
      :title="isQuick ? 'All icons, emoji, words and pictures' : iconLabel(icon)"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="open = true"
    >
      <span v-if="isQuick" class="pi pi-ellipsis-h" aria-hidden="true" />
      <IconBadge v-else inline :icon="icon" colour="currentColor" :fallback="fallback" />
    </button>
  </div>

  <!-- The dialog lives outside the one underneath, so focus goes back to its trigger. -->
  <IconDialog
    v-model:icon="icon"
    v-model:visible="open"
    :colour="colour"
    :owner-noun="ownerNoun"
    :fallback="fallback"
    @after-hide="moreButton?.focus()"
  />
</template>
