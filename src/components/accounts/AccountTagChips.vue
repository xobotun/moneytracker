<script setup lang="ts">
import { computed } from 'vue'
import TagChip from '@/components/tags/TagChip.vue'
import { useTagsStore } from '@/stores/tags'
import type { ShortId } from '@/db/shortId'
import { accountTagChips } from './accountTags'

/**
 * An account's plain tags as filled chips, each labelled by its path, for a
 * row that already lays its chips out in a wrapping line. Deleted tags are
 * left out; archived ones are still on the account, so they show, faint.
 */
const props = defineProps<{ tags: readonly ShortId[] }>()

const store = useTagsStore()
const chips = computed(() => accountTagChips(props.tags, store.byId))
</script>

<template>
  <TagChip
    v-for="chip in chips"
    :key="chip.id"
    class="flex"
    :class="chip.archived ? 'opacity-60' : undefined"
    :label="chip.label"
    :icon="chip.icon"
    :colour="chip.colour"
    :fallback="chip.fallback"
    :sr-prefix="chip.archived ? 'archived tag: ' : 'tag: '"
    :title="chip.archived ? `${chip.label} (archived)` : undefined"
    data-tag-chip
    :data-archived="chip.archived || undefined"
  />
</template>
