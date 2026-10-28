<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import ColourPicker from '@/components/accounts/ColourPicker.vue'
import { DERIVED_CLASS } from '@/components/derived'
import { getImagesRepository } from '@/db/init'
import { iconColourOn } from '@/icons/colours'
import { svgDataUrl } from '@/icons/dataUrl'
import { imageIcon, type Icon, type SetIcon } from '@/icons/types'
import {
  WORD_FONTS,
  WORD_MAX_LENGTH,
  WORD_SIZE,
  defaultWord,
  normaliseHex,
  wordSource,
  wordSvg,
  wordText,
  type WordSettings,
} from '@/icons/wordSvg'
import IconPreview from './IconPreview.vue'

/**
 * The icon dialog's Text tab: a word as the icon — its text, font, weight and
 * colours, previewed as the badges will show it. Saving stores the word's
 * picture (src/icons/wordSvg.ts) with its settings, so it can be edited here
 * again; a change makes a new picture. `start` is the word being edited, or
 * null for a new one on the owner's `colour` (the owner is what the icon is
 * for, a `ownerNoun`: 'merchant', 'account', …).
 */
const props = defineProps<{
  start: WordSettings | null
  colour: string
  ownerNoun: string
  fallback: SetIcon
  active: boolean
}>()
const emit = defineEmits<{ pick: [icon: Icon] }>()

const word = reactive<WordSettings>({ ...(props.start ?? defaultWord(props.colour)) })
const sameColour = (a: string, b: string) => normaliseHex(a) === normaliseHex(b)

// The background a new word starts with, and Reset brings back: the owner's colour.
const ownersBackground = computed(() => defaultWord(props.colour).background)
const backgroundIsOwners = computed(() => sameColour(word.background, ownersBackground.value))
function resetBackground() {
  word.background = ownersBackground.value
}

// The text colour Reset brings back: white or black, whichever reads on the
// background. While the text has it, it follows a change of background.
const readable = computed(() => iconColourOn(word.background))
const textIsReadable = computed(() => sameColour(word.colour, readable.value))
watch(readable, (now, before) => {
  if (sameColour(word.colour, before)) word.colour = now
})
function resetTextColour() {
  word.colour = readable.value
}

const text = computed(() => wordText(word.text))
const svg = computed(() => wordSvg(word))
const preview = computed(() => ({ url: svgDataUrl(svg.value), fills: true }))

const busy = ref(false)
const error = ref<string | null>(null)

// The cleaner loads with the tab, so it is ready when the word is saved.
const cleaner = () => import('@/icons/svgClean')
watch(
  () => props.active,
  (active) => {
    if (active) cleaner().catch(() => {}) // a failure shows on saving
  },
  { immediate: true },
)

async function save() {
  if (text.value === '' || busy.value) return
  busy.value = true
  error.value = null
  try {
    // Cleaned like an upload, which changes nothing in a word's SVG; the
    // generator's own text is stored, so no browser's serialiser can make the
    // same word a second row.
    const { cleanSvg } = await cleaner()
    if (cleanSvg(svg.value).content !== svg.value) {
      console.warn('Cleaning changed a word’s SVG; storing it as generated.')
    }
    const id = await getImagesRepository().put({
      mediaType: 'image/svg+xml',
      content: svg.value,
      width: WORD_SIZE,
      height: WORD_SIZE,
      source: wordSource(word),
    })
    emit('pick', imageIcon(id))
  } catch (e) {
    console.error('Could not save the word.', e)
    error.value = 'Could not save the word. Try again.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="flex flex-col gap-4" novalidate @submit.prevent="save">
    <!-- The result and its action side by side, in view while the settings scroll. -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <IconPreview
        :preview="preview"
        :colour="colour"
        :fallback="fallback"
        :label="text === '' ? 'Preview: no text yet' : `Preview: ${text}`"
      />
      <Button
        type="submit"
        label="Use this word"
        icon="pi pi-check"
        :disabled="text === ''"
        :loading="busy"
        :aria-label="text === '' ? 'Use this word' : `Use the word ${text} as the icon`"
      />
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="flex flex-wrap items-start gap-x-6 gap-y-3">
      <div class="flex w-40 flex-col gap-1">
        <label for="icon-word-text" class="text-sm font-medium">Text</label>
        <InputText
          id="icon-word-text"
          v-model="word.text"
          :maxlength="WORD_MAX_LENGTH"
          autocomplete="off"
          aria-describedby="icon-word-text-hint"
          fluid
        />
        <small id="icon-word-text-hint" class="text-gray-500 dark:text-gray-400">
          Up to 6 characters read best; it shrinks to fit.
        </small>
      </div>
      <div class="flex flex-col gap-1">
        <span id="icon-word-font" class="text-sm font-medium">Font</span>
        <SelectButton
          v-model="word.font"
          :options="[...WORD_FONTS]"
          option-label="label"
          option-value="id"
          :allow-empty="false"
          aria-labelledby="icon-word-font"
        >
          <template #option="{ option }">
            <span :style="{ fontFamily: option.family, fontStretch: option.stretch }">
              {{ option.label }}
            </span>
          </template>
        </SelectButton>
      </div>
      <div class="flex items-center gap-2 sm:mt-8">
        <Checkbox v-model="word.bold" input-id="icon-word-bold" binary />
        <label for="icon-word-bold" class="text-sm font-medium">Bold</label>
      </div>
    </div>

    <fieldset class="flex flex-col">
      <legend class="mb-2 text-sm font-medium">Text colour</legend>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          :class="textIsReadable ? DERIVED_CLASS : undefined"
          :title="textIsReadable ? 'Readable on the background' : undefined"
        >
          <ColourPicker v-model="word.colour" />
        </div>
        <span v-if="textIsReadable" class="text-sm" :class="DERIVED_CLASS">
          Readable on the background
        </span>
        <Button
          v-else
          type="button"
          label="Reset"
          icon="pi pi-undo"
          severity="secondary"
          text
          size="small"
          aria-label="Use a readable text colour"
          @click="resetTextColour"
        />
      </div>
    </fieldset>

    <fieldset class="flex flex-col">
      <legend class="mb-2 text-sm font-medium">Background</legend>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          :class="backgroundIsOwners ? DERIVED_CLASS : undefined"
          :title="backgroundIsOwners ? `The ${ownerNoun}'s colour` : undefined"
        >
          <ColourPicker v-model="word.background" />
        </div>
        <span v-if="backgroundIsOwners" class="text-sm" :class="DERIVED_CLASS">
          The {{ ownerNoun }}'s colour
        </span>
        <Button
          v-else
          type="button"
          label="Reset"
          icon="pi pi-undo"
          severity="secondary"
          text
          size="small"
          :aria-label="`Use the ${ownerNoun}'s colour as background`"
          @click="resetBackground"
        />
      </div>
    </fieldset>
  </form>
</template>
