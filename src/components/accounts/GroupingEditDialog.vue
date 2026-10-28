<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Message from 'primevue/message'
import IconBadge from '@/components/icons/IconBadge.vue'
import ColourPicker from './ColourPicker.vue'
import IconPicker from './IconPicker.vue'
import { useAccountsStore } from '@/stores/accounts'
import type { AccountGrouping } from '@/db/types'
import {
  GROUPING_ICON,
  draftFromGrouping,
  groupingPatchFromDraft,
  newGroupingDraft,
  normaliseGroupingDraft,
  validateGroupingDraft,
  type GroupingDraft,
} from './groupingForm'

/** Edits `grouping`, or creates a new group when it is null. */
const props = defineProps<{ grouping: AccountGrouping | null }>()
const visible = defineModel<boolean>('visible', { required: true })

const store = useAccountsStore()

const draft = ref<GroupingDraft>(newGroupingDraft([]))
const submitted = ref(false)
const saving = ref(false)
const confirmingDelete = ref(false)
const error = ref<string | null>(null)
// While the icon dialog is open on top, Escape closes only it (every open dialog hears the key).
const iconDialogOpen = ref(false)

// Start from a fresh draft each time the dialog opens.
watch(
  visible,
  (open) => {
    if (!open) return
    draft.value = props.grouping
      ? draftFromGrouping(props.grouping)
      : newGroupingDraft(store.groupings)
    submitted.value = false
    confirmingDelete.value = false
    error.value = null
  },
  { immediate: true },
)

const errors = computed(() => validateGroupingDraft(draft.value))
// Errors appear only after the first save attempt, not while typing.
const shownErrors = computed(() => (submitted.value ? errors.value : {}))

const membersFate = computed(() => {
  const n = store.sections.find((s) => s.grouping?.id === props.grouping?.id)?.accounts.length ?? 0
  if (n === 0) return ''
  return n === 1
    ? 'Its account stays and moves below the groups.'
    : `Its ${n} accounts stay and move below the groups.`
})

async function save() {
  submitted.value = true
  if (Object.keys(errors.value).length > 0) return
  const clean = normaliseGroupingDraft(draft.value)
  saving.value = true
  error.value = null
  try {
    if (props.grouping) {
      await store.updateGrouping(props.grouping.id, groupingPatchFromDraft(props.grouping, clean))
    } else {
      await store.createGrouping(clean)
    }
    visible.value = false
  } catch (e) {
    error.value = `Could not save the group. ${(e as Error).message}`
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!props.grouping) return
  saving.value = true
  error.value = null
  try {
    await store.removeGrouping(props.grouping.id)
    visible.value = false
  } catch (e) {
    error.value = `Could not delete the group. ${(e as Error).message}`
    confirmingDelete.value = false
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="grouping ? 'Edit group' : 'New group'"
    :close-on-escape="!iconDialogOpen"
    :draggable="false"
    class="w-[32rem] max-w-[calc(100vw-2rem)]"
  >
    <form class="flex flex-col gap-5" novalidate @submit.prevent="save">
      <div class="flex items-start gap-3">
        <IconBadge
          :icon="draft.icon"
          :colour="draft.colour"
          :fallback="GROUPING_ICON"
          large
          class="mt-6"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label for="grouping-name" class="text-sm font-medium">Name</label>
          <InputText
            id="grouping-name"
            v-model="draft.name"
            autofocus
            maxlength="60"
            autocomplete="off"
            :invalid="!!shownErrors.name"
            :aria-describedby="shownErrors.name ? 'grouping-name-error' : undefined"
          />
          <small v-if="shownErrors.name" id="grouping-name-error" class="text-red-600">
            {{ shownErrors.name }}
          </small>
        </div>
      </div>

      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">Icon</legend>
        <IconPicker
          v-model="draft.icon"
          v-model:open="iconDialogOpen"
          :colour="draft.colour"
          :fallback="GROUPING_ICON"
        />
      </fieldset>

      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">Colour</legend>
        <ColourPicker v-model="draft.colour" />
      </fieldset>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <div
        v-if="confirmingDelete && grouping"
        class="flex flex-col gap-3 rounded-md border border-red-300 p-3 dark:border-red-800"
        role="alert"
      >
        <p>Delete the group “{{ grouping.name }}”? {{ membersFate }}</p>
        <div class="flex justify-end gap-2">
          <Button
            type="button"
            label="Keep it"
            severity="secondary"
            text
            @click="confirmingDelete = false"
          />
          <Button
            type="button"
            label="Delete group"
            severity="danger"
            :loading="saving"
            @click="remove"
          />
        </div>
      </div>
      <div v-else class="flex items-center gap-2">
        <Button
          v-if="grouping"
          type="button"
          label="Delete"
          icon="pi pi-trash"
          severity="danger"
          text
          :disabled="saving"
          @click="confirmingDelete = true"
        />
        <span class="flex-1" />
        <Button type="button" label="Cancel" severity="secondary" text @click="visible = false" />
        <Button type="submit" :label="grouping ? 'Save' : 'Add group'" :loading="saving" />
      </div>
    </form>
  </Dialog>
</template>
