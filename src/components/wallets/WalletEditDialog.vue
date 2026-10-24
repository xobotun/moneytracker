<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import AutoComplete, { type AutoCompleteCompleteEvent } from 'primevue/autocomplete'
import Button from 'primevue/button'
import Message from 'primevue/message'
import WalletBadge from './WalletBadge.vue'
import { useAccountsStore } from '@/stores/accounts'
import type { Account } from '@/db/types'
import {
  WALLET_COLOURS,
  WALLET_COLOUR_NAMES,
  WALLET_ICONS,
  createInputFromDraft,
  currencySuggestions,
  draftFromAccount,
  newWalletDraft,
  normaliseDraft,
  patchFromDraft,
  validateDraft,
  type WalletDraft,
  type WalletDraftErrors,
} from './walletForm'

/** Edits `account`, or creates a new wallet when it is null. */
const props = defineProps<{ account: Account | null }>()
const visible = defineModel<boolean>('visible', { required: true })

const store = useAccountsStore()

const draft = ref<WalletDraft>(newWalletDraft([]))
const submitted = ref(false)
const saving = ref(false)
const confirmingDelete = ref(false)
const error = ref<string | null>(null)

// Start from a fresh draft each time the dialog opens.
watch(
  visible,
  (open) => {
    if (!open) return
    draft.value = props.account ? draftFromAccount(props.account) : newWalletDraft(store.accounts)
    submitted.value = false
    confirmingDelete.value = false
    error.value = null
  },
  { immediate: true },
)

const errors = computed(() => validateDraft(draft.value))
// Errors appear only after the first save attempt, not while typing.
const shownErrors = computed<WalletDraftErrors>(() => (submitted.value ? errors.value : {}))

const currencyOptions = ref<string[]>([])
function completeCurrency(event: AutoCompleteCompleteEvent) {
  currencyOptions.value = currencySuggestions(event.query, store.accounts)
}

// <input type="color"> only accepts #rrggbb; a short #rgb stored elsewhere shows as black.
const pickerValue = computed(() =>
  /^#[0-9a-f]{6}$/i.test(draft.value.colour) ? draft.value.colour : '#000000',
)
const isCustomColour = computed(
  () => !(WALLET_COLOURS as readonly string[]).includes(draft.value.colour.toLowerCase()),
)

function iconLabel(icon: string): string {
  return icon === 'building-columns' ? 'bank' : icon.replace(/-/g, ' ')
}

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
    error.value = `Could not save the wallet. ${(e as Error).message}`
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
    error.value = `Could not delete the wallet. ${(e as Error).message}`
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
    :header="account ? 'Edit wallet' : 'New wallet'"
    :draggable="false"
    class="w-[32rem] max-w-[calc(100vw-2rem)]"
  >
    <form class="flex flex-col gap-5" novalidate @submit.prevent="save">
      <div class="flex items-start gap-3">
        <WalletBadge :icon="draft.icon" :colour="draft.colour" large class="mt-6" />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label for="wallet-name" class="text-sm font-medium">Name</label>
          <InputText
            id="wallet-name"
            v-model="draft.name"
            autofocus
            maxlength="60"
            autocomplete="off"
            :invalid="!!shownErrors.name"
            :aria-describedby="shownErrors.name ? 'wallet-name-error' : undefined"
          />
          <small v-if="shownErrors.name" id="wallet-name-error" class="text-red-600">
            {{ shownErrors.name }}
          </small>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <label for="wallet-currency" class="text-sm font-medium">Currency</label>
        <AutoComplete
          v-model="draft.currency"
          input-id="wallet-currency"
          :suggestions="currencyOptions"
          dropdown
          fluid
          :invalid="!!shownErrors.currency"
          :aria-describedby="
            shownErrors.currency ? 'wallet-currency-error' : 'wallet-currency-hint'
          "
          @complete="completeCurrency"
        />
        <small v-if="shownErrors.currency" id="wallet-currency-error" class="text-red-600">
          {{ shownErrors.currency }}
        </small>
        <small v-else id="wallet-currency-hint" class="text-gray-500 dark:text-gray-400">
          ISO code like EUR, or your own like BTC.
        </small>
      </div>

      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">Icon</legend>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="icon in WALLET_ICONS"
            :key="icon"
            type="button"
            class="flex size-10 items-center justify-center rounded-md border-2 transition-colors"
            :class="
              draft.icon === icon
                ? 'border-(--p-primary-color) text-(--p-primary-color)'
                : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-800'
            "
            :aria-label="iconLabel(icon)"
            :aria-pressed="draft.icon === icon"
            :title="iconLabel(icon)"
            @click="draft.icon = icon"
          >
            <span :class="`pi pi-${icon}`" aria-hidden="true" />
          </button>
        </div>
      </fieldset>

      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">Colour</legend>
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-for="colour in WALLET_COLOURS"
            :key="colour"
            type="button"
            class="size-8 rounded-full ring-offset-2 ring-offset-white dark:ring-offset-gray-900"
            :class="draft.colour.toLowerCase() === colour ? 'ring-2 ring-(--p-primary-color)' : ''"
            :style="{ backgroundColor: colour }"
            :aria-label="WALLET_COLOUR_NAMES[colour]"
            :aria-pressed="draft.colour.toLowerCase() === colour"
            @click="draft.colour = colour"
          />
          <label
            class="relative flex size-8 cursor-pointer items-center justify-center rounded-full border border-dashed border-gray-400 ring-offset-2 ring-offset-white dark:ring-offset-gray-900"
            :class="isCustomColour ? 'ring-2 ring-(--p-primary-color)' : ''"
            :style="isCustomColour ? { backgroundColor: draft.colour } : undefined"
            title="Custom colour"
          >
            <span v-if="!isCustomColour" class="pi pi-palette text-sm" aria-hidden="true" />
            <input
              type="color"
              class="absolute inset-0 size-full cursor-pointer opacity-0"
              aria-label="Custom colour"
              :value="pickerValue"
              @input="draft.colour = ($event.target as HTMLInputElement).value"
            />
          </label>
        </div>
      </fieldset>

      <div class="flex flex-col gap-1">
        <label for="wallet-tags" class="text-sm font-medium">Tags</label>
        <AutoComplete
          v-model="draft.tags"
          input-id="wallet-tags"
          multiple
          :typeahead="false"
          fluid
          aria-describedby="wallet-tags-hint"
        />
        <small id="wallet-tags-hint" class="text-gray-500 dark:text-gray-400">
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
            label="Delete wallet"
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
        <Button type="submit" :label="account ? 'Save' : 'Add wallet'" :loading="saving" />
      </div>
    </form>
  </Dialog>
</template>
