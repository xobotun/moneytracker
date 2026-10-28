<script setup lang="ts">
import { computed, watch } from 'vue'
import type { Icon, SetIcon } from '@/icons/types'
import {
  EMOJI_DISC_CLASS,
  IMAGE_CLASS,
  IMAGE_DISC_CLASS,
  INSET_IMAGE_CLASS,
  badgeFace,
} from '@/icons/face'
import { useImagesStore } from '@/stores/images'

/**
 * An icon in a disc of its owner's colour, for every kind of icon
 * (docs/plans/2026-10-28-icons-design.md §4); `fallback` (the owner's default
 * icon) stands in for one that cannot be drawn. `inline` is the small
 * rendering for chips and picker options, sized by the text around it: a pack
 * icon is a bare icon in the colour, other kinds a tiny badge. Decorative:
 * the name of what it stands for always sits next to it.
 */
const props = withDefaults(
  defineProps<{
    icon: Icon
    colour: string
    fallback: SetIcon
    large?: boolean
    small?: boolean
    inline?: boolean
  }>(),
  { large: false, small: false, inline: false },
)

// The images store only for an image: most badges never need it.
let images: ReturnType<typeof useImagesStore> | null = null
const imagesStore = () => (images ??= useImagesStore())

const imageId = computed(() => (props.icon.kind === 'image' ? props.icon.image : null))
watch(
  imageId,
  (id) => {
    if (id !== null) void imagesStore().load(id)
  },
  { immediate: true },
)

const face = computed(() =>
  badgeFace(
    props.icon,
    props.colour,
    props.fallback,
    imageId.value === null ? undefined : imagesStore().view(imageId.value),
  ),
)

const size = computed(() =>
  props.inline
    ? 'size-[1.4em]'
    : props.large
      ? 'size-12 text-xl'
      : props.small
        ? 'size-8 text-sm'
        : 'size-10 text-base',
)
// An emoji is drawn larger than a pack icon: its picture sits inside its em box.
const emojiSize = computed(() =>
  props.inline ? 'text-[0.9em]' : props.large ? 'text-2xl' : props.small ? 'text-lg' : 'text-xl',
)

const disc = computed(() => {
  const f = face.value
  if (f.kind === 'glyph') {
    return { class: undefined, style: { backgroundColor: f.background, color: f.foreground } }
  }
  if (f.kind === 'emoji') {
    return {
      class: EMOJI_DISC_CLASS,
      style: { '--tint-light': f.tints.light, '--tint-dark': f.tints.dark },
    }
  }
  return {
    class: [IMAGE_DISC_CLASS, props.inline ? 'border' : 'border-2'],
    style: { borderColor: f.ring },
  }
})
</script>

<template>
  <span
    v-if="inline && face.kind === 'glyph'"
    :class="face.className"
    :style="{ color: colour }"
    data-face="glyph"
    aria-hidden="true"
  />
  <span
    v-else
    class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"
    :class="[size, disc.class]"
    :style="disc.style"
    :data-face="face.kind"
    aria-hidden="true"
  >
    <span v-if="face.kind === 'glyph'" :class="face.className" />
    <span v-else-if="face.kind === 'emoji'" class="leading-none" :class="emojiSize">{{
      face.emoji
    }}</span>
    <img
      v-else
      :src="face.url"
      alt=""
      :class="[IMAGE_CLASS, face.fills ? undefined : INSET_IMAGE_CLASS]"
    />
  </span>
</template>
