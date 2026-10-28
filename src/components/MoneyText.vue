<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import type { MoneyAmount } from '@/db/MoneyAmount'
import type { Converted } from '@/money/totals'
import { formatApprox, formatMoney } from '@/format/currency'
import { useLayoutStore } from '@/stores/layout'

/**
 * A read-only amount — every one the app shows goes through here. An exact
 * amount (a MoneyAmount) shows in full (formatMoney), a converted one rounded
 * to its currency's decimals (formatApprox).
 *
 * With "Hide amounts" on (a device setting, see the layout store) it shows a
 * placeholder button instead, and neither the value nor its sign reaches the
 * DOM. Pressing it reveals this amount until the component goes away (the
 * page is left, the dialog closed). `v-model:revealed` lets several amounts
 * reveal together, like a balance and its ≈ base-currency amount.
 *
 * Fields where the user types an amount do not use it.
 */
const props = defineProps<{
  amount: MoneyAmount | Converted
  /** Before the amount, hidden or not: '≈', '≥', '≤'. */
  prefix?: string
  /** Red when negative (only while shown: the colour would give the sign away). */
  signed?: boolean
}>()
// Local state unless the parent binds it.
const revealed = defineModel<boolean>('revealed', { default: false })

const layout = useLayoutStore()
const hidden = computed(() => layout.hideAmounts && !revealed.value)
const text = computed(() =>
  'scale' in props.amount ? formatMoney(props.amount) : formatApprox(props.amount),
)
const red = computed(() =>
  props.signed && props.amount.value < 0 ? 'text-red-600 dark:text-red-400' : undefined,
)
</script>

<template>
  <span v-if="hidden">
    {{ prefix ? `${prefix} ` : ''
    }}<Button
      type="button"
      label="•••"
      severity="secondary"
      text
      size="small"
      aria-label="Amount hidden, show it"
      class="-my-0.5 px-1.5! py-0! align-baseline! text-[length:inherit]!"
      @click="revealed = true"
    />
  </span>
  <span v-else :class="red">{{ prefix ? `${prefix} ${text}` : text }}</span>
</template>
