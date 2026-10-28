<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import Card from 'primevue/card'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import IconBadge from '@/components/icons/IconBadge.vue'
import AccountEditDialog from '@/components/accounts/AccountEditDialog.vue'
import BalanceDisplay from '@/components/accounts/BalanceDisplay.vue'
import { YELLOW_BUTTON } from '@/components/accounts/yellowButton'
import GroupingEditDialog from '@/components/accounts/GroupingEditDialog.vue'
import { groupTints } from '@/components/accounts/groupTint'
import { ACCOUNT_ICON } from '@/components/accounts/accountForm'
import { GROUPING_ICON } from '@/components/accounts/groupingForm'
import { usePointerDrag } from './usePointerDrag'
import { useAccountsStore, type AccountSection } from '@/stores/accounts'
import { useTagsStore } from '@/stores/tags'
import { useMoneySettingsStore } from '@/stores/moneySettings'
import { useRatesStore } from '@/stores/rates'
import { formatDay } from '@/format/date'
import { balanceView, totalView } from '@/money/totals'
import type { Account, AccountGrouping } from '@/db/types'
import type { ShortId } from '@/db/shortId'

const store = useAccountsStore()
const tagsStore = useTagsStore()
const loadError = ref<string | null>(null)

onMounted(async () => {
  try {
    await Promise.all([store.load(), tagsStore.load()])
  } catch (e) {
    loadError.value = `Could not load the accounts. ${(e as Error).message}`
  }
})

/** The account's live tags, by their current names. */
function shownTags(account: Account) {
  return account.tags.flatMap((id) => {
    const tag = tagsStore.byId.get(id)
    return tag && tag.deleted_at_utc === null ? [tag] : []
  })
}

const isEmpty = computed(() => store.accounts.length === 0 && store.groupings.length === 0)

// --- Balances: native, plus ≈ the base currency (see money/totals) ---

const money = useMoneySettingsStore()
const baseCurrency = computed(() => money.baseCurrency)
const rates = useRatesStore()
// Archived accounts are out of the page and group totals; their own section
// shows theirs.
const pageTotal = computed(() => totalView(store.active, baseCurrency.value, rates.table))
const groupTotal = (section: AccountSection) =>
  totalView(section.accounts, baseCurrency.value, rates.table)
const archivedTotal = computed(() => totalView(store.archived, baseCurrency.value, rates.table))
// The archived accounts' section starts collapsed.
const showArchived = ref(false)

// Today's rate from each account currency to the base one, archived accounts
// included. Resolved in the background (fetching what is missing); until then
// the amount shows "no … rate", and it updates when the rate arrives.
const neededPairs = computed(() =>
  [...new Set(store.accounts.map((a) => a.balance.currency))]
    .filter((c) => c !== baseCurrency.value)
    .sort()
    .map((c) => [c, baseCurrency.value] as const),
)
watch(
  () => neededPairs.value.map((pair) => pair.join('>')).join(','),
  () => {
    rates.ensure(neededPairs.value).catch((e) => {
      console.warn('Could not resolve the exchange rates.', e)
    })
  },
  { immediate: true },
)

const refreshingRates = ref(false)
const refreshRatesResult = ref<string | null>(null)

async function refreshRates() {
  refreshingRates.value = true
  try {
    const newest = await rates.refresh()
    refreshRatesResult.value = newest
      ? `Rates refreshed: the newest are from ${formatDay(newest)}.`
      : 'Rates refreshed, but there are none yet.'
  } catch (e) {
    refreshRatesResult.value = `Could not refresh the rates. ${(e as Error).message}`
  } finally {
    refreshingRates.value = false
  }
}

const recalculating = ref(false)
const recalculateResult = ref<string | null>(null)

async function recalculateAll() {
  recalculating.value = true
  try {
    const changed = await store.recalculateBalances()
    recalculateResult.value =
      changed === 0
        ? 'Recalculated: every balance was already right.'
        : `Recalculated: ${changed} balance${changed === 1 ? ' was' : 's were'} off and ${changed === 1 ? 'is' : 'are'} fixed now.`
  } catch (e) {
    recalculateResult.value = `Could not recalculate the balances. ${(e as Error).message}`
  } finally {
    recalculating.value = false
  }
}
const sectionKey = (section: AccountSection) => section.grouping?.id ?? 'ungrouped'

// --- Editing ---

const accountDialogVisible = ref(false)
const editingAccount = ref<Account | null>(null)
const groupingDialogVisible = ref(false)
const editingGrouping = ref<AccountGrouping | null>(null)

function openAccount(account: Account | null) {
  editingAccount.value = account
  accountDialogVisible.value = true
}

function openGrouping(grouping: AccountGrouping | null) {
  editingGrouping.value = grouping
  groupingDialogVisible.value = true
}

// --- Reorder mode: groups and the order of everything. Drag and drop with a
// mouse; arrow buttons for touch and keyboard. An account's arrows run through
// the whole page, so they also move it into the next or previous group. ---

const reordering = ref(false)
const moving = ref(false)
const moveError = ref<string | null>(null)
// Read out by screen readers after each move (the list itself changes silently).
const announcement = ref('')
const page = useTemplateRef<HTMLElement>('page')

/** Runs one move at a time, reporting failures; ignores clicks while one is saving. */
async function runMove(move: () => Promise<void>, announce: () => string) {
  if (moving.value) return
  moving.value = true
  moveError.value = null
  try {
    await move()
    announcement.value = announce()
  } catch (e) {
    moveError.value = `Could not move it. ${(e as Error).message}`
  } finally {
    moving.value = false
  }
}

function describeAccountPlace(id: ShortId): string {
  const section = store.sections.find((s) => s.accounts.some((a) => a.id === id))
  if (!section) return ''
  const position = section.accounts.findIndex((a) => a.id === id) + 1
  const where = section.grouping
    ? ` in ${section.grouping.name}`
    : store.groupings.length > 0
      ? ' below the groups'
      : ''
  return `${where}, position ${position} of ${section.accounts.length}`
}

async function moveAccountTo(account: Account, groupingId: ShortId | null, index: number) {
  await runMove(
    () => store.moveAccount(account.id, groupingId, index),
    () => `${account.name} moved${describeAccountPlace(account.id)}.`,
  )
}

async function stepAccount(account: Account, step: -1 | 1) {
  await runMove(
    () => store.moveAccountBy(account.id, step),
    () => `${account.name} moved${describeAccountPlace(account.id)}.`,
  )
  await refocus('data-move', account.id, step)
}

async function stepGrouping(grouping: AccountGrouping, index: number, step: -1 | 1) {
  await runMove(
    () => store.moveGrouping(grouping.id, index + step),
    () => {
      const position = store.groupings.findIndex((g) => g.id === grouping.id) + 1
      return `${grouping.name} moved to position ${position} of ${store.groupings.length}.`
    },
  )
  await refocus('data-move-group', grouping.id, step)
}

// The moved row is re-inserted in the DOM, which drops keyboard focus. Put it
// back on the same arrow, or on the other one once the row reaches an end.
// A row moved to another group is a new element, and the old one lingers for
// a frame in its leave transition (class v-leave-active) — skip that one.
async function refocus(attribute: string, id: ShortId, step: -1 | 1) {
  await nextTick()
  const first = step === -1 ? 'up' : 'down'
  for (const dir of [first, first === 'up' ? 'down' : 'up']) {
    const button = [
      ...(page.value?.querySelectorAll<HTMLButtonElement>(`[${attribute}="${id}:${dir}"]`) ?? []),
    ].find((b) => !b.closest('.v-leave-active'))
    if (button && !button.disabled) {
      button.focus()
      return
    }
  }
}

type Dragged =
  | { kind: 'account'; account: Account }
  | { kind: 'grouping'; grouping: AccountGrouping }
const dragged = ref<Dragged | null>(null)
// Key of the element a drop would land on, for highlighting.
const dropKey = ref<string | null>(null)

// Drop targets carry a `data-drop-key`, shared by mouse and touch dragging:
//   account:<id>   an account takes that account's place
//   header:<id>    an account goes to the top of the group; a group takes its place
//   block:<id>     anywhere on a group's block: a group takes its place
//   empty:<id>     an empty group, or `empty:ungrouped`: the account becomes its first
function accepts(key: string): boolean {
  const kind = dragged.value?.kind
  if (!kind) return false
  const type = key.split(':')[0]
  if (type === 'header') return true
  if (type === 'block') return kind === 'grouping'
  return kind === 'account'
}

async function dropOn(key: string) {
  const item = dragged.value
  endDrag()
  if (!item) return
  const [type, id] = key.split(':') as [string, string]
  if (item.kind === 'grouping') {
    const index = store.groupings.findIndex((g) => g.id === id)
    if (index === -1) return
    await runMove(
      () => store.moveGrouping(item.grouping.id, index),
      () => `${item.grouping.name} moved to position ${index + 1} of ${store.groupings.length}.`,
    )
  } else if (type === 'account') {
    const section = store.sections.find((s) => s.accounts.some((a) => a.id === id))
    if (!section) return
    const index = section.accounts.findIndex((a) => a.id === id)
    await moveAccountTo(item.account, section.grouping?.id ?? null, index)
  } else if (type === 'header') {
    await moveAccountTo(item.account, id as ShortId, 0)
  } else if (type === 'empty') {
    await moveAccountTo(item.account, id === 'ungrouped' ? null : (id as ShortId), 0)
  }
}

function endDrag() {
  dragged.value = null
  dropKey.value = null
}

// Mouse: native drag and drop of the whole row. Only where a mouse-like
// pointer exists — on a phone, native dragging would fight the finger drag.
const nativeDrag = window.matchMedia?.('(any-pointer: fine)').matches ?? true

function onDragStart(event: DragEvent, item: Dragged) {
  dragged.value = item
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox starts a drag only when some data is set.
    const label = item.kind === 'account' ? item.account.name : item.grouping.name
    event.dataTransfer.setData('text/plain', label)
  }
}

// Drag events bubble from a row to its group block: the innermost target that
// accepts the drag handles it (preventDefault), outer ones see that and skip.
function onDragOver(event: DragEvent, key: string) {
  if (event.defaultPrevented || !accepts(key)) return
  event.preventDefault()
  dropKey.value = key
}

function onDrop(event: DragEvent, key: string) {
  if (event.defaultPrevented || !accepts(key)) return
  event.preventDefault()
  void dropOn(key)
}

// Touch and pen: dragged by the grip, which does not scroll the page.
const pointerDrag = usePointerDrag({
  accepts,
  onOver: (key) => {
    dropKey.value = key
  },
  onEnd: (key) => {
    if (key) void dropOn(key)
    else endDrag()
  },
})

// A mouse is ignored here (it drags natively); a finger has to rest on the
// grip for a moment first, so a brush or a swipe does not move anything.
function onGripDown(event: PointerEvent, item: Dragged) {
  const element = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-drag-item]')
  if (element) pointerDrag.start(event, element, () => (dragged.value = item))
}

const dropHighlight = (key: string) =>
  dropKey.value === key ? 'border-(--p-primary-color)' : 'border-gray-200 dark:border-gray-700'

// A group block is tinted with the group's hue; the theme picks the shade.
function tintStyle(grouping: AccountGrouping) {
  const { light, dark } = groupTints(grouping.colour)
  return { '--tint-light': light, '--tint-dark': dark }
}
</script>

<template>
  <Card>
    <template #title>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span>Accounts</span>
        <div class="flex gap-2">
          <Button
            v-if="!isEmpty"
            :label="reordering ? 'Done' : 'Reorder'"
            :icon="reordering ? 'pi pi-check' : 'pi pi-sort-alt'"
            severity="secondary"
            outlined
            size="small"
            @click="reordering = !reordering"
          />
          <Button
            v-if="reordering"
            label="Add group"
            icon="pi pi-folder-plus"
            size="small"
            @click="openGrouping(null)"
          />
          <Button
            v-else-if="!isEmpty"
            label="Add account"
            icon="pi pi-plus"
            size="small"
            @click="openAccount(null)"
          />
        </div>
      </div>
    </template>

    <template #content>
      <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>

      <p v-else-if="!store.loaded" class="text-gray-500 dark:text-gray-400">Loading accounts…</p>

      <div v-else-if="isEmpty" class="flex flex-col items-center gap-3 py-10 text-center">
        <span class="pi pi-wallet text-4xl text-gray-400" aria-hidden="true" />
        <p class="max-w-sm text-gray-600 dark:text-gray-300">
          No accounts yet. Add one for each place you keep money: a bank account, a card, cash.
        </p>
        <Button label="Add your first account" icon="pi pi-plus" @click="openAccount(null)" />
      </div>

      <div v-else ref="page">
        <p v-if="reordering" class="mb-3 text-sm text-gray-600 dark:text-gray-300">
          Drag groups and accounts, or use their arrows. An account's arrows also move it into the
          next group. The order syncs to your other devices.
        </p>
        <Message v-if="moveError" severity="error" :closable="false" class="mb-3">
          {{ moveError }}
        </Message>

        <div
          v-if="!reordering && pageTotal"
          class="mb-3 flex items-center justify-between gap-3 px-3"
          aria-label="Total of all accounts"
          role="group"
        >
          <span class="font-semibold">Total</span>
          <BalanceDisplay :view="pageTotal" :base-currency="baseCurrency" />
        </div>

        <TransitionGroup
          tag="div"
          move-class="transition-transform duration-200"
          class="flex flex-col gap-3"
        >
          <section
            v-for="(section, sectionIndex) in store.sections"
            v-show="section.grouping || section.accounts.length > 0 || reordering"
            :key="sectionKey(section)"
            :aria-label="section.grouping ? section.grouping.name : 'Accounts in no group'"
            :class="[
              section.grouping
                ? 'flex flex-col gap-2 rounded-xl bg-(--tint-light) p-2 dark:bg-(--tint-dark)'
                : '',
              section.grouping && dropKey === `block:${section.grouping.id}`
                ? 'ring-2 ring-(--p-primary-color)'
                : '',
            ]"
            :style="section.grouping ? tintStyle(section.grouping) : undefined"
            :data-drop-key="section.grouping ? `block:${section.grouping.id}` : undefined"
            :data-drag-item="section.grouping ? '' : undefined"
            @dragover="section.grouping && onDragOver($event, `block:${section.grouping.id}`)"
            @drop="section.grouping && onDrop($event, `block:${section.grouping.id}`)"
          >
            <!-- Group header -->
            <div
              v-if="section.grouping"
              class="flex items-center gap-2 rounded-lg border-2 px-1"
              :class="[
                reordering
                  ? ['border-dashed', dropHighlight(`header:${section.grouping.id}`)]
                  : 'border-transparent',
                dragged?.kind === 'grouping' && dragged.grouping.id === section.grouping.id
                  ? 'opacity-50'
                  : '',
              ]"
              :data-drop-key="`header:${section.grouping.id}`"
              :draggable="reordering && nativeDrag"
              @dragstart="onDragStart($event, { kind: 'grouping', grouping: section.grouping })"
              @dragover="onDragOver($event, `header:${section.grouping.id}`)"
              @drop="onDrop($event, `header:${section.grouping.id}`)"
              @dragend="endDrag"
            >
              <!-- The grip drags with a finger too; touching it never scrolls. -->
              <span
                v-if="reordering"
                class="-my-1 inline-flex size-8 shrink-0 cursor-grab touch-none items-center justify-center text-gray-400 select-none"
                aria-hidden="true"
                @pointerdown="onGripDown($event, { kind: 'grouping', grouping: section.grouping })"
                @contextmenu.prevent
              >
                <span class="pi pi-bars" />
              </span>
              <IconBadge
                :icon="section.grouping.icon"
                :colour="section.grouping.colour"
                :fallback="GROUPING_ICON"
                small
              />
              <h2 class="min-w-0 flex-1 truncate font-semibold">{{ section.grouping.name }}</h2>
              <BalanceDisplay
                v-if="!reordering && groupTotal(section)"
                :view="groupTotal(section)!"
                :base-currency="baseCurrency"
                class="pr-2"
              />
              <template v-if="reordering">
                <Button
                  label="Edit"
                  icon="pi pi-pencil"
                  severity="secondary"
                  text
                  :aria-label="`Edit group ${section.grouping.name}`"
                  :pt="{ label: { class: 'hidden sm:inline' } }"
                  @click="openGrouping(section.grouping)"
                />
                <Button
                  icon="pi pi-arrow-up"
                  severity="secondary"
                  text
                  rounded
                  :aria-label="`Move group ${section.grouping.name} up`"
                  :disabled="sectionIndex === 0"
                  :data-move-group="`${section.grouping.id}:up`"
                  @click="stepGrouping(section.grouping, sectionIndex, -1)"
                />
                <Button
                  icon="pi pi-arrow-down"
                  severity="secondary"
                  text
                  rounded
                  :aria-label="`Move group ${section.grouping.name} down`"
                  :disabled="sectionIndex === store.groupings.length - 1"
                  :data-move-group="`${section.grouping.id}:down`"
                  @click="stepGrouping(section.grouping, sectionIndex, 1)"
                />
              </template>
            </div>

            <TransitionGroup
              tag="ul"
              move-class="transition-transform duration-200"
              class="flex flex-col gap-2"
              :aria-label="section.grouping ? `Accounts in ${section.grouping.name}` : 'Accounts'"
            >
              <li
                v-for="account in section.accounts"
                :key="account.id"
                :data-drop-key="`account:${account.id}`"
                :draggable="reordering && nativeDrag"
                @dragstart="onDragStart($event, { kind: 'account', account })"
                @dragover="onDragOver($event, `account:${account.id}`)"
                @drop="onDrop($event, `account:${account.id}`)"
                @dragend="endDrag"
              >
                <div
                  data-drag-item
                  class="flex items-center gap-3 rounded-lg border bg-(--p-card-background)"
                  :class="[
                    reordering ? 'p-2 pl-3' : 'p-3',
                    reordering
                      ? dropHighlight(`account:${account.id}`)
                      : 'border-gray-200 dark:border-gray-700',
                    dragged?.kind === 'account' && dragged.account.id === account.id
                      ? 'opacity-50'
                      : '',
                  ]"
                >
                  <span
                    v-if="reordering"
                    class="-my-1 -ml-1 inline-flex size-8 shrink-0 cursor-grab touch-none items-center justify-center text-gray-400 select-none"
                    aria-hidden="true"
                    @pointerdown="onGripDown($event, { kind: 'account', account })"
                    @contextmenu.prevent
                  >
                    <span class="pi pi-bars" />
                  </span>
                  <IconBadge
                    :icon="account.icon"
                    :colour="account.colour"
                    :fallback="ACCOUNT_ICON"
                  />
                  <span class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="truncate font-medium">{{ account.name }}</span>
                    <span v-if="!reordering" class="flex flex-wrap items-center gap-1">
                      <Tag :value="account.balance.currency" severity="secondary" />
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
                    v-if="!reordering"
                    :view="balanceView(account, baseCurrency, rates.table)"
                    :base-currency="baseCurrency"
                  />
                  <Button
                    v-if="!reordering"
                    label="Edit"
                    icon="pi pi-pencil"
                    severity="secondary"
                    text
                    :aria-label="`Edit ${account.name}`"
                    :pt="{ label: { class: 'hidden sm:inline' } }"
                    @click="openAccount(account)"
                  />
                  <template v-else>
                    <Button
                      icon="pi pi-arrow-up"
                      severity="secondary"
                      text
                      rounded
                      :aria-label="`Move ${account.name} up`"
                      :disabled="!store.canMoveAccountBy(account.id, -1)"
                      :data-move="`${account.id}:up`"
                      @click="stepAccount(account, -1)"
                    />
                    <Button
                      icon="pi pi-arrow-down"
                      severity="secondary"
                      text
                      rounded
                      :aria-label="`Move ${account.name} down`"
                      :disabled="!store.canMoveAccountBy(account.id, 1)"
                      :data-move="`${account.id}:down`"
                      @click="stepAccount(account, 1)"
                    />
                  </template>
                </div>
              </li>
            </TransitionGroup>

            <!-- Empty group (or, while reordering, the empty no-group area): a drop target. -->
            <p
              v-if="
                section.accounts.length === 0 && (section.grouping || store.groupings.length > 0)
              "
              class="rounded-lg border-2 border-dashed px-3 py-3 text-center text-sm text-gray-500 dark:text-gray-400"
              :class="dropHighlight(`empty:${sectionKey(section)}`)"
              :data-drop-key="`empty:${sectionKey(section)}`"
              @dragover="onDragOver($event, `empty:${sectionKey(section)}`)"
              @drop="onDrop($event, `empty:${sectionKey(section)}`)"
            >
              {{
                section.grouping
                  ? 'No accounts in this group.'
                  : 'Accounts in no group show here, below the groups.'
              }}
            </p>
          </section>
        </TransitionGroup>
        <p class="sr-only" aria-live="polite">{{ announcement }}</p>

        <!-- Archived accounts: apart, collapsed, with their own total; reorder
             mode leaves them out (they keep their group and place). -->
        <section
          v-if="!reordering && store.archived.length > 0"
          class="mt-3 flex flex-col gap-2"
          aria-label="Archived accounts"
        >
          <div class="flex items-center gap-2">
            <Button
              type="button"
              :label="`Archived accounts (${store.archived.length})`"
              :icon="showArchived ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
              severity="secondary"
              text
              :aria-expanded="showArchived"
              aria-controls="archived-accounts"
              @click="showArchived = !showArchived"
            />
            <span class="flex-1" />
            <BalanceDisplay
              v-if="archivedTotal"
              :view="archivedTotal"
              :base-currency="baseCurrency"
              class="pr-3"
              data-archived-total
            />
          </div>
          <ul v-if="showArchived" id="archived-accounts" class="flex flex-col gap-2">
            <li v-for="account in store.archived" :key="account.id">
              <div
                class="flex items-center gap-3 rounded-lg border border-gray-200 bg-(--p-card-background) p-3 dark:border-gray-700"
              >
                <IconBadge :icon="account.icon" :colour="account.colour" :fallback="ACCOUNT_ICON" />
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                  <span class="truncate font-medium">{{ account.name }}</span>
                  <span class="flex flex-wrap items-center gap-1">
                    <Tag :value="account.balance.currency" severity="secondary" />
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
                  @click="openAccount(account)"
                />
              </div>
            </li>
          </ul>
        </section>

        <!-- Balances are a cache of the transactions, kept on every write;
             "Recalculate" rebuilds them all, should one ever be off. "Refresh
             rates" fetches the newest exchange rates now. -->
        <div v-if="!reordering" class="mt-6 flex flex-col items-center gap-2">
          <div class="flex flex-wrap justify-center gap-2">
            <Button
              label="Recalculate balances"
              icon="pi pi-refresh"
              severity="warn"
              :class="YELLOW_BUTTON"
              :loading="recalculating"
              @click="recalculateAll"
            />
            <Button
              label="Refresh rates"
              icon="pi pi-sync"
              severity="secondary"
              outlined
              :loading="refreshingRates"
              @click="refreshRates"
            />
          </div>
          <p
            v-if="recalculateResult"
            role="status"
            class="text-center text-sm text-gray-600 dark:text-gray-300"
          >
            {{ recalculateResult }}
          </p>
          <p
            v-if="refreshRatesResult"
            role="status"
            class="text-center text-sm text-gray-600 dark:text-gray-300"
          >
            {{ refreshRatesResult }}
          </p>
        </div>
      </div>

      <AccountEditDialog v-model:visible="accountDialogVisible" :account="editingAccount" />
      <GroupingEditDialog v-model:visible="groupingDialogVisible" :grouping="editingGrouping" />
    </template>
  </Card>
</template>
