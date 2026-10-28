<script setup lang="ts">
import type { SetIcon } from '@/icons/types'
import type { ImageView } from '@/stores/images'
import IconBadge from './IconBadge.vue'

/** A picture not stored yet, as the badges will show it: at every size, and close up. */
defineProps<{ preview: ImageView; colour: string; fallback: SetIcon; label: string }>()
</script>

<template>
  <div class="flex items-end gap-4" role="img" :aria-label="label">
    <IconBadge :icon="fallback" :colour="colour" :fallback="fallback" :preview="preview" small />
    <IconBadge :icon="fallback" :colour="colour" :fallback="fallback" :preview="preview" />
    <IconBadge :icon="fallback" :colour="colour" :fallback="fallback" :preview="preview" large />
    <IconBadge :icon="fallback" :colour="colour" :fallback="fallback" :preview="preview" xl />
  </div>
</template>
