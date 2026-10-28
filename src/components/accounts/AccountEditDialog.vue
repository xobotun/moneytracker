<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import AutoComplete from 'primevue/autocomplete'
import Checkbox from 'primevue/checkbox'
import Button from 'primevue/button'
import Message from 'primevue/message'
import IconBadge from '@/components/icons/IconBadge.vue'
import ColourPicker from './ColourPicker.vue'
import IconPicker from './IconPicker.vue'
import { YELLOW_BUTTON } from './yellowButton'
import { useAccountsStore } from '@/stores/accounts'
import { useTagsStore } from '@/stores/tags'
import type { Account } from '@/db/types'
import type { ShortId } from '@/db/shortId'
import CurrencyInput from '@/components/CurrencyInput.vue'
import { currencyName, currencySymbol, formatMoney } from '@/format/currency'
import {
  ACCOUNT_ICON,
  createInputFromDraft,
  currenciesByUse,
  draftFromAccount,
  hiddenTagIds,
  newAccountDraft,
  normaliseDraft,
  patchFromDraft,
  tagIdsToSave,
  validateDraft,
  type AccountDraft,
  type AccountDraftErrors,
} from './accountForm'

/** Edits `account`, or creates a new account when it is null. */
const props = defineProps<{ account: Account | null }>()
const visible = defineModel<boolean>('visible', { required: true })

const store = useAccountsStore()
const tagsStore = useTagsStore()

const draft = ref<AccountDraft>(newAccountDraft([]))
// Tag ids the draft cannot show (deleted or unknown tags); saving keeps them.
// Taken when the dialog opens: saving reloads the tags store meanwhile.
const hiddenTags = ref<ShortId[]>([])
const submitted = ref(false)
const saving = ref(false)
const confirmingDelete = ref(false)
const error = ref<string | null>(null)
const recalculating = ref(false)
const recalculated = ref<string | null>(null)
const currencyLocked = ref(false)
// Transactions on the account being edited; null while counting (or for a new one).
const transactionCount = ref<number | null>(null)

/** A tag's name for the editor; null for a deleted or unknown tag. */
function visibleTagName(id: ShortId): string | null {
  const tag = tagsStore.byId.get(id)
  return tag && tag.deleted_at_utc === null ? tag.name : null
}

// Start from a fresh draft each time the dialog opens.
watch(
  visible,
  (open) => {
    if (!open) return
    draft.value = props.account
      ? draftFromAccount(props.account, visibleTagName)
      : newAccountDraft(store.accounts)
    hiddenTags.value = props.account ? hiddenTagIds(props.account, visibleTagName) : []
    submitted.value = false
    confirmingDelete.value = false
    error.value = null
    recalculated.value = null
    void checkCurrencyLock()
  },
  { immediate: true },
)

// An account that transactions use keeps its currency (their amounts are in
// it, and its balance counts only amounts in its own currency): the dialog
// shows it read-only instead of the picker. Read-only until the count is
// known, so it cannot change in between.
async function checkCurrencyLock() {
  const account = props.account
  currencyLocked.value = account !== null
  transactionCount.value = null
  if (!account) return
  try {
    const n = await store.transactionCount(account.id)
    if (props.account?.id !== account.id) return // the dialog moved on meanwhile
    transactionCount.value = n
    currencyLocked.value = n > 0
  } catch (e) {
    error.value = `Could not check the account's transactions, so its currency stays as it is. ${(e as Error).message}`
  }
}

const errors = computed(() => validateDraft(draft.value))
// Errors appear only after the first save attempt, not while typing.
const shownErrors = computed<AccountDraftErrors>(() => (submitted.value ? errors.value : {}))

// While the suggestions are open, Escape closes only them, not the dialog
// (both listen for it; the dialog reads this flag when the key is pressed).
const currencyListOpen = ref(false)
// Likewise while the icon dialog is open on top of this one.
const iconDialogOpen = ref(false)

async function save() {
  submitted.value = true
  if (Object.keys(errors.value).length > 0) return
  const clean = normaliseDraft(draft.value)
  saving.value = true
  error.value = null
  try {
    const tagIds = await tagsStore.resolvePlainTags(clean.tags, props.account?.tags)
    if (props.account) {
      const toSave = tagIdsToSave(props.account.tags, tagIds, hiddenTags.value)
      await store.update(props.account.id, patchFromDraft(props.account, clean, toSave))
    } else {
      await store.create(createInputFromDraft(clean, tagIds))
    }
    visible.value = false
  } catch (e) {
    error.value = `Could not save the account. ${(e as Error).message}`
  } finally {
    saving.value = false
  }
}

// The balance is a cache of the transactions; this rebuilds it for this account.
async function recalculate() {
  if (!props.account) return
  const id = props.account.id
  recalculating.value = true
  error.value = null
  try {
    const changed = await store.recalculateBalance(id)
    const balance = store.accounts.find((a) => a.id === id)?.balance
    const shown = balance ? formatMoney(balance) : ''
    recalculated.value = changed
      ? `The balance was off; it is ${shown} now.`
      : `The balance was already right: ${shown}.`
  } catch (e) {
    error.value = `Could not recalculate the balance. ${(e as Error).message}`
  } finally {
    recalculating.value = false
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
    :close-on-escape="!currencyListOpen && !iconDialogOpen"
    class="w-[32rem] max-w-[calc(100vw-2rem)]"
  >
    <form class="flex flex-col gap-5" novalidate @submit.prevent="save">
      <div class="flex items-start gap-3">
        <IconBadge
          :icon="draft.icon"
          :colour="draft.colour"
          :fallback="ACCOUNT_ICON"
          large
          class="mt-6"
        />
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

      <!-- Read-only once transactions use the account (see checkCurrencyLock). -->
      <div v-if="currencyLocked && account" class="flex flex-col gap-1">
        <span class="text-sm font-medium">Currency</span>
        <p
          id="account-currency-value"
          class="flex min-h-10 items-center gap-3 rounded-md bg-gray-100 px-3 dark:bg-white/5"
        >
          <span class="font-medium">{{ account.balance.currency }}</span>
          <span v-if="currencySymbol(account.balance.currency)">
            {{ currencySymbol(account.balance.currency) }}
          </span>
          <span class="text-sm text-gray-500 dark:text-gray-400">
            {{ currencyName(account.balance.currency) }}
          </span>
          <span v-if="transactionCount" class="text-xs text-gray-500 dark:text-gray-400">
            ({{ transactionCount }} transaction{{ transactionCount === 1 ? '' : 's' }})
          </span>
        </p>
      </div>
      <div v-else class="flex flex-col gap-1">
        <label for="account-currency" class="text-sm font-medium">Currency</label>
        <CurrencyInput
          v-model="draft.currency"
          :preferred="currenciesByUse(store.accounts)"
          input-id="account-currency"
          fluid
          :invalid="!!shownErrors.currency"
          :describedby="shownErrors.currency ? 'account-currency-error' : 'account-currency-hint'"
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

      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <Checkbox
            v-model="draft.is_cash"
            input-id="account-is-cash"
            binary
            :pt="{ input: { 'aria-describedby': 'account-is-cash-hint' } }"
          />
          <label for="account-is-cash" class="text-sm font-medium">Cash</label>
        </div>
        <small id="account-is-cash-hint" class="text-gray-500 dark:text-gray-400">
          Money in hand, like a wallet, rather than in a bank.
        </small>
      </div>

      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">Icon</legend>
        <IconPicker
          v-model="draft.icon"
          v-model:open="iconDialogOpen"
          :colour="draft.colour"
          owner-noun="account"
          :fallback="ACCOUNT_ICON"
        />
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
          :pt="{ input: { 'aria-describedby': 'account-tags-hint' } }"
        />
        <small id="account-tags-hint" class="text-gray-500 dark:text-gray-400">
          Optional. Type a tag and press Enter.
        </small>
      </div>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <Message v-if="recalculated" severity="info" :closable="false">{{ recalculated }}</Message>

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
          aria-label="Delete account"
          :pt="{ label: { class: 'hidden sm:inline' } }"
          :disabled="saving"
          @click="confirmingDelete = true"
        />
        <Button
          v-if="account"
          type="button"
          label="Recalculate"
          icon="pi pi-refresh"
          severity="warn"
          :class="YELLOW_BUTTON"
          aria-label="Recalculate balance"
          :pt="{ label: { class: 'hidden sm:inline' } }"
          :loading="recalculating"
          :disabled="saving"
          @click="recalculate"
        />
        <span class="flex-1" />
        <Button type="button" label="Cancel" severity="secondary" text @click="visible = false" />
        <Button type="submit" :label="account ? 'Save' : 'Add account'" :loading="saving" />
      </div>
    </form>
  </Dialog>
</template>
