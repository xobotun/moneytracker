<script setup lang="ts">
import { computed, ref } from 'vue'
import InputText from 'primevue/inputtext'
import { ICON_SETS, iconLabel, type IconSet } from '@/icons/sets'
import { setIcon, type Icon } from '@/icons/types'

/** The icon dialog's Icons tab: every icon of every installed pack, one section each, searchable. */
const props = defineProps<{ icon: Icon }>()
const emit = defineEmits<{ pick: [icon: Icon] }>()

const query = ref('')
const sections = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/\s+/g, '-')
  return ICON_SETS.map((set) => ({
    set,
    names: q === '' ? set.names : set.names.filter((name) => name.includes(q)),
  }))
})
const found = computed(() => sections.value.some(({ names }) => names.length > 0))

const isPicked = (set: IconSet, name: string) =>
  props.icon.kind === 'set' && props.icon.set === set.id && props.icon.name === name

const tileClass = (selected: boolean) =>
  selected
    ? 'border-(--p-primary-color) text-(--p-primary-color)'
    : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-800'
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="sticky top-0 z-10 bg-(--p-overlay-modal-background) pb-1">
      <InputText
        v-model="query"
        placeholder="Search icons"
        aria-label="Search icons"
        size="small"
        fluid
      />
    </div>
    <template v-for="{ set, names } in sections" :key="set.id">
      <section v-if="names.length > 0" class="flex flex-col gap-1">
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">{{ set.label }}</h3>
        <div
          role="group"
          :aria-label="set.label"
          class="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1"
        >
          <button
            v-for="name in names"
            :key="name"
            type="button"
            class="flex size-9 items-center justify-center rounded-md border-2 transition-colors"
            :class="tileClass(isPicked(set, name))"
            :aria-label="iconLabel(setIcon(set.id, name))"
            :aria-pressed="isPicked(set, name)"
            :title="iconLabel(setIcon(set.id, name))"
            @click="emit('pick', setIcon(set.id, name))"
          >
            <span :class="set.className(name)" aria-hidden="true" />
          </button>
        </div>
      </section>
    </template>
    <p v-if="!found" class="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
      No icon matches “{{ query }}”.
    </p>
  </div>
</template>
