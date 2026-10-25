<script setup lang="ts">
import { computed } from 'vue'
import { formatApprox, formatMoney } from '@/format/currency'
import type { BalanceView } from '@/money/totals'

/** A balance: the exact native amount, and ≈ the base currency (smaller) when it is another. */
const props = defineProps<{ view: BalanceView; baseCurrency: string }>()

const negative = computed(() =>
  props.view.native ? props.view.native.value < 0 : (props.view.base?.value ?? 0) < 0,
)
const red = 'text-red-600 dark:text-red-400'
</script>

<template>
  <span class="flex shrink-0 flex-col items-end text-right tabular-nums">
    <span v-if="view.native" class="font-semibold" :class="negative ? red : ''">
      {{ formatMoney(view.native) }}
    </span>
    <span
      v-if="view.base"
      :class="
        view.native
          ? 'text-xs text-gray-500 dark:text-gray-400'
          : ['font-semibold', negative ? red : '']
      "
    >
      ≈ {{ formatApprox(view.base) }}
    </span>
    <span v-else-if="view.missingRates.length > 0" class="text-xs text-gray-500 dark:text-gray-400">
      no {{ view.missingRates.join(', ') }} → {{ baseCurrency }} rate
    </span>
  </span>
</template>
