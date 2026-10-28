<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import PrimeTag from 'primevue/tag'
import AccountBadge from '@/components/accounts/AccountBadge.vue'
import { accountIconClass } from '@/components/accounts/accountForm'
import type { TagLook } from '@/tags/look'
import type { RowFact, RowLink, TreeRow } from '@/tags/tree'
import { DERIVED_CLASS } from '@/components/derived'

/**
 * One tag on the Tags page, indented by depth, with its badge and buttons.
 * Detailed: its name and what it links to, then its other names and
 * description, then its details (`facts`), each line only when it has any,
 * wrapped rather than cut. Slim: one line, adding the link from `sm` and the
 * other names and description from `md`, cut to fit.
 */
const props = defineProps<{
  row: TreeRow
  look: TagLook
  /** Synonyms and merged names, shown on the second line. */
  otherNames: readonly string[]
  /** Shown as plain text after the name: no link, the row stays one target. */
  link: RowLink | null
  /** A location's address and radius, a journey's dates: shown on detailed rows. */
  facts: readonly RowFact[]
  detailed: boolean
  duplicate: boolean
  noun: string
}>()

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// The second line: other names, then the description.
const more = computed(() =>
  [props.otherNames.join(', '), props.row.tag.description ?? '']
    .filter((part) => part !== '')
    .join(' · '),
)
const emit = defineEmits<{ toggle: []; add: []; edit: [] }>()
</script>

<template>
  <div
    class="flex items-center gap-2 rounded-md py-1 pr-1"
    :class="duplicate ? 'outline-2 outline-amber-400 dark:outline-amber-500' : undefined"
    :style="{ paddingLeft: `${Math.min(row.depth, 6) * 1.25}rem` }"
  >
    <Button
      v-if="row.hasChildren"
      type="button"
      :icon="row.open ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
      severity="secondary"
      text
      rounded
      size="small"
      :aria-expanded="row.open"
      :aria-label="`${row.open ? 'Collapse' : 'Expand'} ${row.tag.name}`"
      @click="emit('toggle')"
    />
    <span v-else class="w-8 shrink-0" aria-hidden="true" />
    <AccountBadge :icon="look.icon" :colour="look.colour" small />
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex min-w-0 items-center gap-x-2" :class="detailed ? 'flex-wrap' : undefined">
        <span class="font-medium" :class="detailed ? 'break-words' : 'truncate'">
          {{ row.tag.name }}
        </span>
        <!-- A chip, not a link: the row stays one target. -->
        <span
          v-if="link"
          data-link
          class="min-w-0 shrink-[2] items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-white/10 dark:text-gray-200"
          :class="detailed ? 'flex max-w-full' : 'hidden sm:flex'"
          :title="`${capitalise(link.role)}: ${link.label}${link.deleted ? ' (deleted)' : ''}`"
        >
          <span class="sr-only">{{ `${link.role}: ` }}</span>
          <span
            :class="accountIconClass(link.look.icon)"
            class="text-[0.7rem]"
            :style="{ color: link.look.colour }"
            aria-hidden="true"
          />
          <span class="truncate" :class="link.deleted ? 'line-through' : undefined">
            {{ link.label }}
          </span>
          <span v-if="link.deleted" class="shrink-0">{{ ' (deleted)' }}</span>
        </span>
        <span
          v-if="!detailed && more"
          class="hidden min-w-0 truncate text-sm text-gray-500 md:block dark:text-gray-400"
          :title="more"
        >
          {{ more }}
        </span>
      </div>
      <template v-if="detailed">
        <p v-if="more" data-more class="text-sm break-words text-gray-500 dark:text-gray-400">
          {{ more }}
        </p>
        <p
          v-if="facts.length > 0"
          data-facts
          class="text-sm break-words text-gray-500 dark:text-gray-400"
        >
          <template v-for="(fact, i) in facts" :key="i">
            <span v-if="i > 0" aria-hidden="true">{{ ' · ' }}</span>
            <span :class="fact.derived ? DERIVED_CLASS : undefined" :title="fact.title">
              {{ fact.text }}
            </span>
          </template>
        </p>
      </template>
    </div>
    <PrimeTag v-if="duplicate" severity="warn" value="Duplicate" />
    <Button
      type="button"
      label="Add"
      icon="pi pi-plus"
      severity="secondary"
      text
      size="small"
      :aria-label="`Add a ${noun} under ${row.tag.name}`"
      :pt="{ label: { class: 'hidden sm:inline' } }"
      @click="emit('add')"
    />
    <Button
      type="button"
      label="Edit"
      icon="pi pi-pencil"
      severity="secondary"
      text
      size="small"
      :aria-label="`Edit ${row.tag.name}`"
      :pt="{ label: { class: 'hidden sm:inline' } }"
      @click="emit('edit')"
    />
  </div>
</template>
