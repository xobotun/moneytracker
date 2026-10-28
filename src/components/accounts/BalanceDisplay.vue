<script setup lang="ts">
import { computed, ref } from 'vue'
import MoneyText from '@/components/MoneyText.vue'
import type { BalanceView } from '@/money/totals'

/**
 * A balance: the exact native amount, and ≈ the base currency (smaller) when
 * it is another. A total over mixed currencies shows only the base amount,
 * with its relation (≈ / ≥ / ≤) and, beside it or below when there is no
 * room, the currencies that have no rate. While amounts are hidden, showing
 * one of them shows both: they are the same balance.
 */
const props = defineProps<{ view: BalanceView; baseCurrency: string }>()

const revealed = ref(false)
const missingNote = computed(() =>
  props.view.missingRates.length > 0
    ? `no ${props.view.missingRates.join(', ')} → ${props.baseCurrency} rate`
    : null,
)
const muted = 'text-xs text-gray-500 dark:text-gray-400'
</script>

<template>
  <!-- At most 60% of the row, so a long note wraps instead of squeezing the name. -->
  <span class="flex max-w-[60%] min-w-0 flex-col items-end text-right tabular-nums">
    <template v-if="view.native">
      <MoneyText
        v-model:revealed="revealed"
        :amount="view.native"
        signed
        class="font-semibold whitespace-nowrap"
      />
      <MoneyText
        v-if="view.base"
        v-model:revealed="revealed"
        :amount="view.base"
        prefix="≈"
        :class="muted"
        class="whitespace-nowrap"
      />
      <span v-else-if="missingNote" :class="muted">{{ missingNote }}</span>
    </template>
    <span v-else class="flex flex-wrap items-baseline justify-end gap-x-2">
      <MoneyText
        v-if="view.base"
        v-model:revealed="revealed"
        :amount="view.base"
        :prefix="view.relation"
        signed
        class="font-semibold whitespace-nowrap"
      />
      <span v-if="missingNote" :class="muted">{{ missingNote }}</span>
    </span>
  </span>
</template>
