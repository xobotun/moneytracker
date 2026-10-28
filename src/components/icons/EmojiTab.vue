<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import Message from 'primevue/message'
import { emojiIcon, type Icon } from '@/icons/types'

/**
 * The icon dialog's Emoji tab: a full emoji picker with search. The library
 * and its data load the first time the tab opens (src/icons/emojiPicker.ts).
 * Only an emoji from the picker can be chosen, never typed text.
 */
const props = defineProps<{ active: boolean }>()
const emit = defineEmits<{ pick: [icon: Icon] }>()

const host = useTemplateRef<HTMLElement>('host')
const state = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
let unmount: (() => void) | null = null
let gone = false

async function load() {
  state.value = 'loading'
  try {
    const { mountEmojiPicker } = await import('@/icons/emojiPicker')
    if (gone || !host.value) return
    unmount = mountEmojiPicker(host.value, {
      dark: document.documentElement.classList.contains('dark'),
      onPick: (emoji) => emit('pick', emojiIcon(emoji)),
    })
    state.value = 'ready'
  } catch (e) {
    console.error('Could not load the emoji picker.', e)
    state.value = 'failed'
  }
}

onMounted(() => {
  watch(
    () => props.active,
    (active) => {
      if (active && state.value === 'idle') void load()
    },
    { immediate: true },
  )
})

onBeforeUnmount(() => {
  gone = true
  unmount?.()
})
</script>

<template>
  <div class="flex h-full min-h-[22rem] flex-col gap-2">
    <p
      v-if="state === 'loading'"
      class="py-4 text-center text-sm text-gray-500 dark:text-gray-400"
      role="status"
    >
      Loading emoji…
    </p>
    <Message v-if="state === 'failed'" severity="error" :closable="false">
      The emoji could not be loaded. Close this dialog and try again.
    </Message>
    <div ref="host" class="min-h-[22rem] flex-1" data-emoji-host />
  </div>
</template>
