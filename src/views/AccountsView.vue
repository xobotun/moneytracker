<script setup lang="ts">
import { nextTick, onMounted, ref, useTemplateRef } from 'vue'
import Card from 'primevue/card'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import AccountBadge from '@/components/accounts/AccountBadge.vue'
import AccountEditDialog from '@/components/accounts/AccountEditDialog.vue'
import { useAccountsStore } from '@/stores/accounts'
import type { Account } from '@/db/types'
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

// --- Editing ---

const dialogVisible = ref(false)
const editing = ref<Account | null>(null)

function openNew() {
  editing.value = null
  dialogVisible.value = true
}

function openEdit(account: Account) {
  editing.value = account
  dialogVisible.value = true
}

// --- Reordering: drag and drop with a mouse, arrow buttons for touch and keyboard ---

const reordering = ref(false)
const moving = ref(false)
const moveError = ref<string | null>(null)
// Read out by screen readers after each move (the list itself changes silently).
const announcement = ref('')
const list = useTemplateRef<HTMLElement>('list')

async function moveTo(account: Account, toIndex: number, focus?: 'up' | 'down') {
  if (moving.value) return
  moving.value = true
  moveError.value = null
  try {
    await store.move(account.id, toIndex)
    const position = store.accounts.findIndex((a) => a.id === account.id) + 1
    announcement.value = `${account.name} moved to position ${position} of ${store.accounts.length}.`
  } catch (e) {
    moveError.value = `Could not move the account. ${(e as Error).message}`
  } finally {
    moving.value = false
  }
  if (focus) await refocus(account.id, focus)
}

// The moved row is re-inserted in the DOM, which drops keyboard focus. Put it
// back on the same arrow, or on the other one once the row reaches an end.
async function refocus(id: UUID, direction: 'up' | 'down') {
  await nextTick()
  const other = direction === 'up' ? 'down' : 'up'
  for (const dir of [direction, other]) {
    const button = list.value?.querySelector<HTMLButtonElement>(`[data-move="${id}:${dir}"]`)
    if (button && !button.disabled) {
      button.focus()
      return
    }
  }
}

const draggingId = ref<UUID | null>(null)
const dropIndex = ref<number | null>(null)

function onDragStart(event: DragEvent, account: Account) {
  draggingId.value = account.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox starts a drag only when some data is set.
    event.dataTransfer.setData('text/plain', account.name)
  }
}

function onDragOver(index: number) {
  if (draggingId.value !== null) dropIndex.value = index
}

async function onDrop(index: number) {
  const account = store.accounts.find((a) => a.id === draggingId.value)
  endDrag()
  if (account) await moveTo(account, index)
}

function endDrag() {
  draggingId.value = null
  dropIndex.value = null
}
</script>

<template>
  <Card>
    <template #title>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span>Accounts</span>
        <div class="flex gap-2">
          <Button
            v-if="store.accounts.length > 1"
            :label="reordering ? 'Done' : 'Reorder'"
            :icon="reordering ? 'pi pi-check' : 'pi pi-sort-alt'"
            severity="secondary"
            outlined
            size="small"
            @click="reordering = !reordering"
          />
          <Button
            v-if="!reordering && store.accounts.length > 0"
            label="Add account"
            icon="pi pi-plus"
            size="small"
            @click="openNew"
          />
        </div>
      </div>
    </template>

    <template #content>
      <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>

      <p v-else-if="!store.loaded" class="text-gray-500 dark:text-gray-400">Loading accounts…</p>

      <div
        v-else-if="store.accounts.length === 0"
        class="flex flex-col items-center gap-3 py-10 text-center"
      >
        <span class="pi pi-wallet text-4xl text-gray-400" aria-hidden="true" />
        <p class="max-w-sm text-gray-600 dark:text-gray-300">
          No accounts yet. Add one for each place you keep money: a bank account, a card, cash.
        </p>
        <Button label="Add your first account" icon="pi pi-plus" @click="openNew" />
      </div>

      <template v-else>
        <p v-if="reordering" class="mb-3 text-sm text-gray-600 dark:text-gray-300">
          Drag an account or use its arrows to change the order. The order syncs to your other
          devices.
        </p>
        <Message v-if="moveError" severity="error" :closable="false" class="mb-3">
          {{ moveError }}
        </Message>

        <div ref="list">
          <TransitionGroup
            tag="ul"
            move-class="transition-transform duration-200"
            class="flex flex-col gap-2"
            aria-label="Accounts"
          >
            <li
              v-for="(account, index) in store.accounts"
              :key="account.id"
              :draggable="reordering"
              @dragstart="onDragStart($event, account)"
              @dragover.prevent="onDragOver(index)"
              @drop.prevent="onDrop(index)"
              @dragend="endDrag"
            >
              <div
                v-if="!reordering"
                class="flex items-center gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
              >
                <AccountBadge :icon="account.icon" :colour="account.colour" />
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                  <span class="truncate font-medium">{{ account.name }}</span>
                  <span class="flex flex-wrap items-center gap-1">
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
                  label="Edit"
                  icon="pi pi-pencil"
                  severity="secondary"
                  text
                  :aria-label="`Edit ${account.name}`"
                  :pt="{ label: { class: 'hidden sm:inline' } }"
                  @click="openEdit(account)"
                />
              </div>

              <div
                v-else
                class="flex items-center gap-3 rounded-lg border p-2 pl-3 transition-colors"
                :class="[
                  dropIndex === index && draggingId !== account.id
                    ? 'border-(--p-primary-color) bg-gray-50 dark:bg-gray-800'
                    : 'border-gray-200 dark:border-gray-700',
                  draggingId === account.id ? 'opacity-50' : '',
                ]"
              >
                <span class="pi pi-bars cursor-grab text-gray-400" aria-hidden="true" />
                <AccountBadge :icon="account.icon" :colour="account.colour" />
                <span class="min-w-0 flex-1 truncate font-medium">{{ account.name }}</span>
                <Button
                  icon="pi pi-arrow-up"
                  severity="secondary"
                  text
                  rounded
                  :aria-label="`Move ${account.name} up`"
                  :disabled="index === 0"
                  :data-move="`${account.id}:up`"
                  @click="moveTo(account, index - 1, 'up')"
                />
                <Button
                  icon="pi pi-arrow-down"
                  severity="secondary"
                  text
                  rounded
                  :aria-label="`Move ${account.name} down`"
                  :disabled="index === store.accounts.length - 1"
                  :data-move="`${account.id}:down`"
                  @click="moveTo(account, index + 1, 'down')"
                />
              </div>
            </li>
          </TransitionGroup>
        </div>
        <p class="sr-only" aria-live="polite">{{ announcement }}</p>
      </template>

      <AccountEditDialog v-model:visible="dialogVisible" :account="editing" />
    </template>
  </Card>
</template>
