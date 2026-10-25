<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import Popover from 'primevue/popover'
import InputText from 'primevue/inputtext'
import { QUICK_ICONS, iconLabel } from './accountForm'
import { PRIME_ICONS } from './primeIcons'

/** The selected PrimeIcons name, without the `pi-` prefix. */
const icon = defineModel<string>({ required: true })

const popover = useTemplateRef<InstanceType<typeof Popover>>('popover')
const panel = useTemplateRef<HTMLElement>('panel')
const moreButton = useTemplateRef<HTMLButtonElement>('moreButton')
const open = ref(false)
const query = ref('')

const isQuick = computed(() => (QUICK_ICONS as readonly string[]).includes(icon.value))
const matching = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/\s+/g, '-')
  return q === '' ? PRIME_ICONS : PRIME_ICONS.filter((name) => name.includes(q))
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
  icon.value = name
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
      :class="tileClass(icon === name)"
      :aria-label="iconLabel(name)"
      :aria-pressed="icon === name"
      :title="iconLabel(name)"
      @click="icon = name"
    >
      <span :class="`pi pi-${name}`" aria-hidden="true" />
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
      <span :class="isQuick ? 'pi pi-ellipsis-h' : `pi pi-${icon}`" aria-hidden="true" />
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
          :class="tileClass(icon === name)"
          :aria-label="iconLabel(name)"
          :aria-pressed="icon === name"
          :title="iconLabel(name)"
          @click="pick(name)"
        >
          <span :class="`pi pi-${name}`" aria-hidden="true" />
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
