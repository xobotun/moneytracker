<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { getImagesRepository } from '@/db/init'
import { encodeRaster } from '@/icons/rasterEncode'
import { imageIcon, type Icon, type SetIcon } from '@/icons/types'
import {
  UploadError,
  WARN_IMAGE_BYTES,
  formatBytes,
  prepareUpload,
  type PreparedImage,
} from '@/icons/upload'
import type { ImageView } from '@/stores/images'
import IconPreview from './IconPreview.vue'

/**
 * The icon dialog's Image tab: a picture from a file — a logo, a photo, an
 * SVG — previewed as the badges will show it, then stored
 * (src/icons/upload.ts). `current` is the picture the icon shows now, if it
 * is an upload.
 */
const props = defineProps<{
  current: ImageView | null
  colour: string
  fallback: SetIcon
  active: boolean
}>()
const emit = defineEmits<{ pick: [icon: Icon] }>()

const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const fileName = ref('')
const prepared = ref<PreparedImage | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)

const preview = computed<ImageView | null>(() =>
  prepared.value ? { url: prepared.value.url, fills: false } : null,
)

// The SVG cleaner loads with the tab, so it is ready when a file is chosen.
const cleaner = () => import('@/icons/svgClean')
watch(
  () => props.active,
  (active) => {
    if (active) cleaner().catch(() => {}) // a failure shows when a file is chosen
  },
  { immediate: true },
)

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // so choosing the same file again reads it again
  if (!file) return
  fileName.value = file.name
  prepared.value = null
  error.value = null
  busy.value = true
  try {
    const { cleanSvg } = await cleaner()
    prepared.value = await prepareUpload(file, { cleanSvg, encodeRaster })
  } catch (e) {
    if (!(e instanceof UploadError)) console.error('Could not read the picture.', e)
    error.value = e instanceof UploadError ? e.message : 'Could not read this file. Try again.'
  } finally {
    busy.value = false
  }
}

async function use() {
  const picture = prepared.value
  if (!picture || busy.value) return
  busy.value = true
  error.value = null
  try {
    emit('pick', imageIcon(await getImagesRepository().put(picture.input)))
  } catch (e) {
    console.error('Could not save the picture.', e)
    error.value = 'Could not save the picture. Try again.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-sm text-gray-500 dark:text-gray-400">
      A logo or any picture: PNG, JPEG, WebP, GIF or SVG. Pictures are scaled down to 256 × 256; an
      SVG stays sharp at any size.
    </p>
    <div class="flex min-w-0 items-center gap-3">
      <Button
        type="button"
        label="Choose a file"
        icon="pi pi-upload"
        severity="secondary"
        aria-label="Choose a picture file"
        :loading="busy && prepared === null"
        @click="fileInput?.click()"
      />
      <span v-if="fileName" class="min-w-0 truncate text-sm" :title="fileName">{{ fileName }}</span>
    </div>
    <input
      ref="fileInput"
      type="file"
      accept="image/*,.svg"
      class="hidden"
      tabindex="-1"
      aria-hidden="true"
      data-image-file
      @change="onFile"
    />

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <template v-if="prepared && preview">
      <Message v-if="prepared.warn" severity="warn" :closable="false">
        This picture is {{ formatBytes(prepared.bytes) }}. Every device syncs this picture, so a
        large one slows down every sync; under {{ formatBytes(WARN_IMAGE_BYTES) }} is best.
      </Message>
      <!-- The result and its action side by side. -->
      <div class="flex flex-wrap items-end justify-between gap-3">
        <IconPreview
          :preview="preview"
          :colour="colour"
          :fallback="fallback"
          :label="`Preview of ${fileName}`"
        />
        <Button
          v-if="prepared.warn"
          type="button"
          label="Use it anyway"
          icon="pi pi-check"
          severity="warn"
          :loading="busy"
          :aria-label="`Use ${fileName} anyway, ${formatBytes(prepared.bytes)}`"
          @click="use"
        />
        <Button
          v-else
          type="button"
          label="Use this image"
          icon="pi pi-check"
          :loading="busy"
          :aria-label="`Use ${fileName} as the icon`"
          @click="use"
        />
      </div>
      <p class="text-sm text-gray-500 dark:text-gray-400">
        {{ prepared.input.mediaType === 'image/svg+xml' ? 'SVG' : 'Picture' }},
        {{ prepared.input.width }} × {{ prepared.input.height }}, {{ formatBytes(prepared.bytes) }}
      </p>
    </template>
    <template v-else-if="current && !error && !busy">
      <IconPreview
        :preview="current"
        :colour="colour"
        :fallback="fallback"
        label="The current picture"
      />
      <p class="text-sm text-gray-500 dark:text-gray-400">
        The current picture. Choose a file to replace it.
      </p>
    </template>
  </div>
</template>
