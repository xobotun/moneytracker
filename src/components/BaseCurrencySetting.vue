<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import CurrencyInput from '@/components/CurrencyInput.vue'
import { useMoneySettingsStore } from '@/stores/moneySettings'
import { currencyCodeError, normaliseCurrencyCode } from '@/format/currency'

const store = useMoneySettingsStore()
const draft = ref(store.baseCurrency)
const error = ref<string | null>(null)
const saving = ref(false)

watch(
  () => store.baseCurrency,
  (value) => (draft.value = value),
)

// Picking a suggestion saves at once; a typed code (a custom one like BTC)
// waits for Save, so leaving the field half-typed never saves anything.
const unsaved = computed(() => normaliseCurrencyCode(draft.value) !== store.baseCurrency)

async function save(value: string) {
  error.value = currencyCodeError(value)
  if (error.value || normaliseCurrencyCode(value) === store.baseCurrency) return
  saving.value = true
  try {
    await store.setBaseCurrency(value)
  } catch (e) {
    error.value = `Could not save the base currency. ${(e as Error).message}`
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <label for="base-currency">Base currency</label>
      <div class="flex gap-2">
        <CurrencyInput
          v-model="draft"
          :preferred="[store.baseCurrency]"
          input-id="base-currency"
          :invalid="!!error"
          :aria-describedby="error ? 'base-currency-error' : 'base-currency-hint'"
          @option-select="save($event.value)"
        />
        <Button v-if="unsaved" label="Save" :loading="saving" @click="save(draft)" />
      </div>
    </div>
    <small v-if="error" id="base-currency-error" class="text-red-600 sm:text-right">
      {{ error }}
    </small>
    <small v-else id="base-currency-hint" class="text-gray-500 sm:text-right dark:text-gray-400">
      Money in different currencies is totalled in this one.
    </small>
  </div>
</template>
