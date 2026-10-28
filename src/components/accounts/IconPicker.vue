<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import Popover from 'primevue/popover'
import InputText from 'primevue/inputtext'
import IconBadge from '@/components/icons/IconBadge.vue'
import { PRIME_ICON_SET, QUICK_ICONS, iconLabel, isPrimeIcon, primeIcon } from '@/icons/sets'
import type { Icon, SetIcon } from '@/icons/types'

/** Picks a PrimeIcons icon; `fallback` draws a picked icon of another kind that cannot be drawn. */
defineProps<{ fallback: SetIcon }>()
const icon = defineModel<Icon>({ required: true })

const popover = useTemplateRef<InstanceType<typeof Popover>>('popover')
const panel = useTemplateRef<HTMLElement>('panel')
const moreButton = useTemplateRef<HTMLButtonElement>('moreButton')
const open = ref(false)
const query = ref('')

const NAMES = PRIME_ICON_SET.names
const isQuick = computed(() => QUICK_ICONS.some((name) => isPrimeIcon(icon.value, name)))
const matching = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/\s+/g, '-')
  return q === '' ? NAMES : NAMES.filter((name) => name.includes(q))
})

const tileClass = (selected: boolean) =>
  selected
    ? 'border-(--p-primary-color) text-(--p-primary-color)'
    : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-800'

function onShow() {
  open.value = true
  panel.value?.querySelector('input')?.focus()
}

function toggleAll(event: Event) {
  query.value = ''
  popover.value?.toggle(event)
}

function pick(name: string) {
  icon.value = primeIcon(name)
  close()
}

// The popover lives outside the dialog, so hand focus back to its trigger.
function close() {
  popover.value?.hide()
  moreButton.value?.focus()
}
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
      :title="isQuick ? 'All icons' : iconLabel(icon)"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="toggleAll"
    >
      <span v-if="isQuick" class="pi pi-ellipsis-h" aria-hidden="true" />
      <IconBadge v-else inline :icon="icon" colour="currentColor" :fallback="fallback" />
    </button>
  </div>

  <Popover ref="popover" @show="onShow" @hide="open = false">
    <!-- Escape must close only the popover, not the dialog underneath. -->
    <div
      ref="panel"
      class="flex w-72 flex-col gap-2 sm:w-96"
      role="dialog"
      aria-label="All icons"
      @keydown.esc.stop="close"
    >
      <InputText
        v-model="query"
        placeholder="Search icons"
        aria-label="Search icons"
        size="small"
      />
      <div class="grid max-h-64 grid-cols-7 gap-1 overflow-y-auto sm:grid-cols-9">
        <button
          v-for="name in matching"
          :key="name"
          type="button"
          class="flex size-9 items-center justify-center rounded-md border-2 transition-colors"
          :class="tileClass(isPrimeIcon(icon, name))"
          :aria-label="iconLabel(primeIcon(name))"
          :aria-pressed="isPrimeIcon(icon, name)"
          :title="iconLabel(primeIcon(name))"
          @click="pick(name)"
        >
          <span :class="PRIME_ICON_SET.className(name)" aria-hidden="true" />
        </button>
      </div>
      <p
        v-if="matching.length === 0"
        class="py-4 text-center text-sm text-gray-500 dark:text-gray-400"
      >
        No icon matches “{{ query }}”.
      </p>
    </div>
  </Popover>
</template>
