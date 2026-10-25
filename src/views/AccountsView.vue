<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import Card from 'primevue/card'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import AccountBadge from '@/components/accounts/AccountBadge.vue'
import AccountEditDialog from '@/components/accounts/AccountEditDialog.vue'
import GroupingEditDialog from '@/components/accounts/GroupingEditDialog.vue'
import { groupTints } from '@/components/accounts/groupTint'
import { useAccountsStore, type AccountSection } from '@/stores/accounts'
import type { Account, AccountGrouping } from '@/db/types'
import type { UUID } from '@/db/uuid'

const store = useAccountsStore()
const loadError = ref<string | null>(null)

onMounted(async () => {
  try {
    await store.load()
  } catch (e) {
    loadError.value = `Could not load the accounts. ${(e as Error).message}`
  }
})

const isEmpty = computed(() => store.accounts.length === 0 && store.groupings.length === 0)
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

function describeAccountPlace(id: UUID): string {
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

async function moveAccountTo(account: Account, groupingId: UUID | null, index: number) {
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
async function refocus(attribute: string, id: UUID, step: -1 | 1) {
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

function onDragStart(event: DragEvent, item: Dragged) {
  dragged.value = item
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox starts a drag only when some data is set.
    const label = item.kind === 'account' ? item.account.name : item.grouping.name
    event.dataTransfer.setData('text/plain', label)
  }
}

/** Accepts the drag over `key` only for what can land there (preventDefault allows the drop). */
function onDragOver(event: DragEvent, key: string, accepts: Dragged['kind'][]) {
  if (!dragged.value || !accepts.includes(dragged.value.kind)) return
  event.preventDefault()
  dropKey.value = key
}

function endDrag() {
  dragged.value = null
  dropKey.value = null
}

/** An account dropped on an account row takes that row's place. */
async function dropOnAccount(section: AccountSection, index: number) {
  const item = dragged.value
  endDrag()
  if (item?.kind === 'account')
    await moveAccountTo(item.account, section.grouping?.id ?? null, index)
}

/** On a group header: a group takes its place, an account goes to the group's top. */
async function dropOnGroupingHeader(grouping: AccountGrouping, index: number) {
  const item = dragged.value
  endDrag()
  if (item?.kind === 'grouping') {
    await runMove(
      () => store.moveGrouping(item.grouping.id, index),
      () => `${item.grouping.name} moved to position ${index + 1} of ${store.groupings.length}.`,
    )
  } else if (item?.kind === 'account') {
    await moveAccountTo(item.account, grouping.id, 0)
  }
}

/** On a section's empty-slot placeholder: the account becomes its first. */
async function dropOnEmptySection(section: AccountSection) {
  const item = dragged.value
  endDrag()
  if (item?.kind === 'account') await moveAccountTo(item.account, section.grouping?.id ?? null, 0)
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
            :class="
              section.grouping
                ? 'flex flex-col gap-2 rounded-xl bg-(--tint-light) p-2 dark:bg-(--tint-dark)'
                : ''
            "
            :style="section.grouping ? tintStyle(section.grouping) : undefined"
          >
            <!-- Group header -->
            <div
              v-if="section.grouping"
              class="flex items-center gap-2 rounded-lg border-2 px-1"
              :class="[
                reordering
                  ? ['border-dashed', dropHighlight(`grouping:${section.grouping.id}`)]
                  : 'border-transparent',
                dragged?.kind === 'grouping' && dragged.grouping.id === section.grouping.id
                  ? 'opacity-50'
                  : '',
              ]"
              :draggable="reordering"
              @dragstart="onDragStart($event, { kind: 'grouping', grouping: section.grouping })"
              @dragover="
                onDragOver($event, `grouping:${section.grouping.id}`, ['grouping', 'account'])
              "
              @drop.prevent="dropOnGroupingHeader(section.grouping, sectionIndex)"
              @dragend="endDrag"
            >
              <span
                v-if="reordering"
                class="pi pi-bars cursor-grab text-gray-400"
                aria-hidden="true"
              />
              <AccountBadge :icon="section.grouping.icon" :colour="section.grouping.colour" small />
              <h2 class="min-w-0 flex-1 truncate font-semibold">{{ section.grouping.name }}</h2>
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
                v-for="(account, index) in section.accounts"
                :key="account.id"
                :draggable="reordering"
                @dragstart="onDragStart($event, { kind: 'account', account })"
                @dragover="onDragOver($event, `account:${account.id}`, ['account'])"
                @drop.prevent="dropOnAccount(section, index)"
                @dragend="endDrag"
              >
                <div
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
                    class="pi pi-bars cursor-grab text-gray-400"
                    aria-hidden="true"
                  />
                  <AccountBadge :icon="account.icon" :colour="account.colour" />
                  <span class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="truncate font-medium">{{ account.name }}</span>
                    <span v-if="!reordering" class="flex flex-wrap items-center gap-1">
                      <Tag :value="account.balance.currency" severity="secondary" />
                      <span
                        v-for="tag in account.tags"
                        :key="tag"
                        class="text-xs text-gray-500 dark:text-gray-400"
                      >
                        #{{ tag }}
                      </span>
                    </span>
                  </span>
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
              @dragover="onDragOver($event, `empty:${sectionKey(section)}`, ['account'])"
              @drop.prevent="dropOnEmptySection(section)"
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
      </div>

      <AccountEditDialog v-model:visible="accountDialogVisible" :account="editingAccount" />
      <GroupingEditDialog v-model:visible="groupingDialogVisible" :grouping="editingGrouping" />
    </template>
  </Card>
</template>
