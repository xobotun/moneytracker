<script setup lang="ts">
import Button from 'primevue/button'
import PrimeTag from 'primevue/tag'
import IconBadge from '@/components/icons/IconBadge.vue'
import TagChip from './TagChip.vue'
import NamePills from './NamePills.vue'
import type { TagLook } from '@/tags/look'
import type { RowFact, RowLink, TreeRow } from '@/tags/tree'
import { DERIVED_CLASS } from '@/components/derived'

/**
 * One tag on the Tags page, indented by depth, with its badge and buttons.
 * Detailed: its name and what it links to, then its other names as outlined
 * pills, then its description with its line breaks, then its details
 * (`facts`), each line only when it has any, wrapped rather than cut. Slim:
 * one line, adding the link from `sm` and the pills and description from
 * `md`, cut to fit.
 */
defineProps<{
  row: TreeRow
  look: TagLook
  /** Synonyms and merged names, one outlined pill each. */
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
    <IconBadge v-bind="look" small />
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex min-w-0 items-center gap-x-2" :class="detailed ? 'flex-wrap' : undefined">
        <span class="font-medium" :class="detailed ? 'break-words' : 'truncate'">
          {{ row.tag.name }}
        </span>
        <!-- A chip, not a link: the row stays one target. -->
        <TagChip
          v-if="link"
          data-link
          :label="link.label"
          :icon="link.look.icon"
          :colour="link.look.colour"
          :fallback="link.look.fallback"
          :deleted="link.deleted"
          :sr-prefix="`${link.role}: `"
          class="shrink-[2]"
          :class="detailed ? 'flex max-w-full' : 'hidden sm:flex'"
          :title="`${capitalise(link.role)}: ${link.label}${link.deleted ? ' (deleted)' : ''}`"
        />
        <template v-if="!detailed">
          <!-- Cut at the edge rather than wrapped: the row stays one line. -->
          <NamePills
            v-if="otherNames.length > 0"
            data-names
            :names="otherNames"
            label="Other names"
            one-line
            class="hidden shrink-[3] md:flex"
          />
          <!-- Only the room left over; newlines collapse into the one line. -->
          <span
            v-if="row.tag.description"
            class="hidden min-w-0 flex-1 truncate text-sm text-gray-500 md:block dark:text-gray-400"
            :title="row.tag.description"
          >
            {{ row.tag.description }}
          </span>
        </template>
      </div>
      <template v-if="detailed">
        <NamePills
          v-if="otherNames.length > 0"
          data-names
          :names="otherNames"
          label="Other names"
          class="mt-0.5 flex"
        />
        <p
          v-if="row.tag.description"
          data-description
          class="text-sm break-words whitespace-pre-line text-gray-500 dark:text-gray-400"
        >
          {{ row.tag.description }}
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
