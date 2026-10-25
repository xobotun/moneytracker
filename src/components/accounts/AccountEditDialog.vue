<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import AutoComplete from 'primevue/autocomplete'
import Button from 'primevue/button'
import Message from 'primevue/message'
import AccountBadge from './AccountBadge.vue'
import ColourPicker from './ColourPicker.vue'
import IconPicker from './IconPicker.vue'
import { useAccountsStore } from '@/stores/accounts'
import type { Account } from '@/db/types'
import CurrencyInput from '@/components/CurrencyInput.vue'
import {
  createInputFromDraft,
  currenciesByUse,
  draftFromAccount,
  newAccountDraft,
  normaliseDraft,
  patchFromDraft,
  validateDraft,
  type AccountDraft,
  type AccountDraftErrors,
} from './accountForm'

/** Edits `account`, or creates a new account when it is null. */
const props = defineProps<{ account: Account | null }>()
const visible = defineModel<boolean>('visible', { required: true })

const store = useAccountsStore()

const draft = ref<AccountDraft>(newAccountDraft([]))
const submitted = ref(false)
const saving = ref(false)
const confirmingDelete = ref(false)
const error = ref<string | null>(null)

// Start from a fresh draft each time the dialog opens.
watch(
  visible,
  (open) => {
    if (!open) return
    draft.value = props.account ? draftFromAccount(props.account) : newAccountDraft(store.accounts)
    submitted.value = false
    confirmingDelete.value = false
    error.value = null
  },
  { immediate: true },
)

const errors = computed(() => validateDraft(draft.value))
// Errors appear only after the first save attempt, not while typing.
const shownErrors = computed<AccountDraftErrors>(() => (submitted.value ? errors.value : {}))

// While the suggestions are open, Escape closes only them, not the dialog
// (both listen for it; the dialog reads this flag when the key is pressed).
const currencyListOpen = ref(false)

async function save() {
  submitted.value = true
  if (Object.keys(errors.value).length > 0) return
  const clean = normaliseDraft(draft.value)
  saving.value = true
  error.value = null
  try {
    if (props.account) await store.update(props.account.id, patchFromDraft(props.account, clean))
    else await store.create(createInputFromDraft(clean))
    visible.value = false
  } catch (e) {
    error.value = `Could not save the account. ${(e as Error).message}`
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!props.account) return
  saving.value = true
  error.value = null
  try {
    await store.remove(props.account.id)
    visible.value = false
  } catch (e) {
    error.value = `Could not delete the account. ${(e as Error).message}`
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
    :header="account ? 'Edit account' : 'New account'"
    :draggable="false"
    :close-on-escape="!currencyListOpen"
    class="w-[32rem] max-w-[calc(100vw-2rem)]"
  >
    <form class="flex flex-col gap-5" novalidate @submit.prevent="save">
      <div class="flex items-start gap-3">
        <AccountBadge :icon="draft.icon" :colour="draft.colour" large class="mt-6" />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label for="account-name" class="text-sm font-medium">Name</label>
          <InputText
            id="account-name"
            v-model="draft.name"
            autofocus
            maxlength="60"
            autocomplete="off"
            :invalid="!!shownErrors.name"
            :aria-describedby="shownErrors.name ? 'account-name-error' : undefined"
          />
          <small v-if="shownErrors.name" id="account-name-error" class="text-red-600">
            {{ shownErrors.name }}
          </small>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <label for="account-currency" class="text-sm font-medium">Currency</label>
        <CurrencyInput
          v-model="draft.currency"
          :preferred="currenciesByUse(store.accounts)"
          input-id="account-currency"
          fluid
          :invalid="!!shownErrors.currency"
          :aria-describedby="
            shownErrors.currency ? 'account-currency-error' : 'account-currency-hint'
          "
          @show="currencyListOpen = true"
          @hide="currencyListOpen = false"
        />
        <small v-if="shownErrors.currency" id="account-currency-error" class="text-red-600">
          {{ shownErrors.currency }}
        </small>
        <small v-else id="account-currency-hint" class="text-gray-500 dark:text-gray-400">
          ISO code like EUR, or your own like BTC.
        </small>
      </div>

      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">Icon</legend>
        <IconPicker v-model="draft.icon" />
      </fieldset>

      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">Colour</legend>
        <ColourPicker v-model="draft.colour" />
      </fieldset>

      <div class="flex flex-col gap-1">
        <label for="account-tags" class="text-sm font-medium">Tags</label>
        <AutoComplete
          v-model="draft.tags"
          input-id="account-tags"
          multiple
          :typeahead="false"
          fluid
          aria-describedby="account-tags-hint"
        />
        <small id="account-tags-hint" class="text-gray-500 dark:text-gray-400">
          Optional. Type a tag and press Enter.
        </small>
      </div>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <div
        v-if="confirmingDelete && account"
        class="flex flex-col gap-3 rounded-md border border-red-300 p-3 dark:border-red-800"
        role="alert"
      >
        <p>Delete “{{ account.name }}”? It is removed on every device this app syncs with.</p>
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
            label="Delete account"
            severity="danger"
            :loading="saving"
            @click="remove"
          />
        </div>
      </div>
      <div v-else class="flex items-center gap-2">
        <Button
          v-if="account"
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
        <Button type="submit" :label="account ? 'Save' : 'Add account'" :loading="saving" />
      </div>
    </form>
  </Dialog>
</template>
