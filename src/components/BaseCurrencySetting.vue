<script setup lang="ts">
import { ref, watch } from 'vue'
import CurrencyInput from '@/components/CurrencyInput.vue'
import { useMoneySettingsStore } from '@/stores/moneySettings'
import { currencyCodeError, normaliseCurrencyCode } from '@/format/currency'

const store = useMoneySettingsStore()
const draft = ref(store.baseCurrency)
const error = ref<string | null>(null)

watch(
  () => store.baseCurrency,
  (value) => (draft.value = value),
)

async function save(value: string) {
  error.value = currencyCodeError(value)
  if (error.value || normaliseCurrencyCode(value) === store.baseCurrency) return
  try {
    await store.setBaseCurrency(value)
  } catch (e) {
    error.value = `Could not save the base currency. ${(e as Error).message}`
  }
}

// Saves when a suggestion is picked or the field loses focus. Pressing on a
// suggestion blurs the field before the pick lands, so a blur while the list
// is open waits for it to close — by then a pick has set the value, and a
// half-typed one ("ru" on the way to RUB) is never saved. The before-* events
// fire as the list starts to open or close; show/hide wait for the animation.
const listOpen = ref(false)
let blurredWithListOpen = false

function onBlur() {
  if (listOpen.value) blurredWithListOpen = true
  else void save(draft.value)
}

function onListHidden() {
  listOpen.value = false
  if (!blurredWithListOpen) return
  blurredWithListOpen = false
  void save(draft.value)
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <label for="base-currency">Base currency</label>
      <CurrencyInput
        v-model="draft"
        :preferred="[store.baseCurrency]"
        input-id="base-currency"
        :invalid="!!error"
        :aria-describedby="error ? 'base-currency-error' : 'base-currency-hint'"
        @option-select="save($event.value)"
        @blur="onBlur"
        @before-show="listOpen = true"
        @before-hide="onListHidden"
      />
    </div>
    <small v-if="error" id="base-currency-error" class="text-red-600 sm:text-right">
      {{ error }}
    </small>
    <small v-else id="base-currency-hint" class="text-gray-500 sm:text-right dark:text-gray-400">
      Money in different currencies is totalled in this one.
    </small>
  </div>
</template>
