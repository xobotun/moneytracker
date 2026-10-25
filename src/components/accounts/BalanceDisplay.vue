<script setup lang="ts">
import { computed } from 'vue'
import { formatApprox, formatMoney } from '@/format/currency'
import type { BalanceView } from '@/money/totals'

/**
 * A balance: the exact native amount, and ≈ the base currency (smaller) when
 * it is another. A total over mixed currencies shows only the base amount,
 * with its relation (≈ / ≥ / ≤) and, beside it or below when there is no
 * room, the currencies that have no rate.
 */
const props = defineProps<{ view: BalanceView; baseCurrency: string }>()

const negative = computed(() =>
  props.view.native ? props.view.native.value < 0 : (props.view.base?.value ?? 0) < 0,
)
const missingNote = computed(() =>
  props.view.missingRates.length > 0
    ? `no ${props.view.missingRates.join(', ')} → ${props.baseCurrency} rate`
    : null,
)
const red = 'text-red-600 dark:text-red-400'
const muted = 'text-xs text-gray-500 dark:text-gray-400'
</script>

<template>
  <!-- At most 60% of the row, so a long note wraps instead of squeezing the name. -->
  <span class="flex max-w-[60%] min-w-0 flex-col items-end text-right tabular-nums">
    <template v-if="view.native">
      <span class="font-semibold whitespace-nowrap" :class="negative ? red : ''">
        {{ formatMoney(view.native) }}
      </span>
      <span v-if="view.base" :class="muted" class="whitespace-nowrap">
        ≈ {{ formatApprox(view.base) }}
      </span>
      <span v-else-if="missingNote" :class="muted">{{ missingNote }}</span>
    </template>
    <span v-else class="flex flex-wrap items-baseline justify-end gap-x-2">
      <span v-if="view.base" class="font-semibold whitespace-nowrap" :class="negative ? red : ''">
        {{ view.relation }} {{ formatApprox(view.base) }}
      </span>
      <span v-if="missingNote" :class="muted">{{ missingNote }}</span>
    </span>
  </span>
</template>
