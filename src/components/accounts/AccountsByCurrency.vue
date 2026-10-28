<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import IconBadge from '@/components/icons/IconBadge.vue'
import MoneyText from '@/components/MoneyText.vue'
import TagChip from '@/components/tags/TagChip.vue'
import BalanceDisplay from './BalanceDisplay.vue'
import { ACCOUNT_ICON } from './accountForm'
import { GROUPING_ICON } from './groupingForm'
import { byCurrency, type MoneyKind } from './byCurrency'
import { useAccountsStore } from '@/stores/accounts'
import { useTagsStore } from '@/stores/tags'
import { useMoneySettingsStore } from '@/stores/moneySettings'
import { useRatesStore } from '@/stores/rates'
import { currencyName } from '@/format/currency'
import { balanceView, totalView } from '@/money/totals'
import type { Account } from '@/db/types'

/**
 * The active accounts by currency instead of by group (the Accounts page's
 * "Show by currency"): a block per currency with its total, and in it the
 * cash and the bank accounts side by side, each with its exact subtotal.
 * Every row names its group, so that grouping is not lost.
 */
const emit = defineEmits<{ edit: [account: Account] }>()

const store = useAccountsStore()
const tagsStore = useTagsStore()
const money = useMoneySettingsStore()
const rates = useRatesStore()

const baseCurrency = computed(() => money.baseCurrency)
const blocks = computed(() => byCurrency(store.sections, baseCurrency.value))

const KINDS: Record<MoneyKind, { label: string; icon: string }> = {
  cash: { label: 'Cash', icon: 'pi pi-money-bill' },
  bank: { label: 'Bank', icon: 'pi pi-building-columns' },
}

/** The account's live tags, by their current names. */
function shownTags(account: Account) {
  return account.tags.flatMap((id) => {
    const tag = tagsStore.byId.get(id)
    return tag && tag.deleted_at_utc === null ? [tag] : []
  })
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <p v-if="blocks.length === 0" class="px-3 text-gray-500 dark:text-gray-400">
      No active accounts.
    </p>
    <section
      v-for="block in blocks"
      :key="block.currency"
      :aria-label="`Accounts in ${block.currency}`"
      class="flex flex-col gap-2 rounded-xl bg-gray-100 p-2 dark:bg-white/5"
      data-currency-block
    >
      <div class="flex items-center gap-2 px-1">
        <h2 class="font-semibold">{{ block.currency }}</h2>
        <span class="min-w-0 flex-1 truncate text-sm text-gray-500 dark:text-gray-400">
          {{ currencyName(block.currency) }}
        </span>
        <BalanceDisplay
          :view="totalView(block.accounts, baseCurrency, rates.table)!"
          :base-currency="baseCurrency"
          class="pr-2"
          data-currency-total
        />
      </div>

      <div class="grid gap-2" :class="block.kinds.length === 2 ? 'md:grid-cols-2' : undefined">
        <div
          v-for="group in block.kinds"
          :key="group.kind"
          role="group"
          :aria-label="`${KINDS[group.kind].label} in ${block.currency}`"
          class="flex min-w-0 flex-col gap-2"
          :data-kind="group.kind"
        >
          <div class="flex items-center gap-2 px-2 text-sm">
            <span :class="KINDS[group.kind].icon" class="text-gray-500" aria-hidden="true" />
            <h3 class="flex-1 font-semibold">{{ KINDS[group.kind].label }}</h3>
            <MoneyText
              :amount="group.total"
              signed
              class="font-semibold whitespace-nowrap tabular-nums"
              data-kind-total
            />
          </div>
          <ul class="flex flex-col gap-2">
            <li v-for="{ account, grouping } in group.rows" :key="account.id">
              <div
                class="flex items-center gap-3 rounded-lg border border-gray-200 bg-(--p-card-background) p-3 dark:border-gray-700"
              >
                <IconBadge :icon="account.icon" :colour="account.colour" :fallback="ACCOUNT_ICON" />
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                  <span class="truncate font-medium">{{ account.name }}</span>
                  <span class="flex flex-wrap items-center gap-1">
                    <TagChip
                      v-if="grouping"
                      class="flex"
                      :label="grouping.name"
                      :icon="grouping.icon"
                      :colour="grouping.colour"
                      :fallback="GROUPING_ICON"
                      sr-prefix="group: "
                      data-group-chip
                    />
                    <span
                      v-for="tag in shownTags(account)"
                      :key="tag.id"
                      class="text-xs text-gray-500 dark:text-gray-400"
                    >
                      #{{ tag.name }}
                    </span>
                  </span>
                </span>
                <BalanceDisplay
                  :view="balanceView(account, baseCurrency, rates.table)"
                  :base-currency="baseCurrency"
                />
                <Button
                  label="Edit"
                  icon="pi pi-pencil"
                  severity="secondary"
                  text
                  :aria-label="`Edit ${account.name}`"
                  :pt="{ label: { class: 'hidden sm:inline' } }"
                  @click="emit('edit', account)"
                />
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>
