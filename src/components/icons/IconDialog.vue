<script setup lang="ts">
import { ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Tab from 'primevue/tab'
import TabList from 'primevue/tablist'
import TabPanel from 'primevue/tabpanel'
import TabPanels from 'primevue/tabpanels'
import Tabs from 'primevue/tabs'
import { getImagesRepository } from '@/db/init'
import { imageDataUrl } from '@/icons/dataUrl'
import type { Icon, SetIcon } from '@/icons/types'
import { wordFromSource, type WordSettings } from '@/icons/wordSvg'
import type { ImageView } from '@/stores/images'
import EmojiTab from './EmojiTab.vue'
import IconsTab from './IconsTab.vue'
import ImageTab from './ImageTab.vue'
import TextTab from './TextTab.vue'

/**
 * Every way to choose an icon (docs/plans/2026-10-28-icons-design.md §5): a
 * pack icon, an emoji, a word or a picture, one tab each. Choosing in any
 * tab sets the icon and closes. It opens on the tab of the icon it is given:
 * a word on Text with its settings, an uploaded picture on Image showing it.
 * `colour` is the owner's colour: the badges' ring, a new word's background.
 */
const props = defineProps<{ colour: string; fallback: SetIcon }>()
const icon = defineModel<Icon>('icon', { required: true })
const visible = defineModel<boolean>('visible', { required: true })
const emit = defineEmits<{ 'after-hide': [] }>()

type TabName = 'icons' | 'emoji' | 'text' | 'image'
const tab = ref<TabName>('icons')
/** The word the Text tab starts from; null for a new one. */
const word = ref<WordSettings | null>(null)
/** The uploaded picture the Image tab shows; null when the icon is none. */
const upload = ref<ImageView | null>(null)
/** The dialog shows once it knows which tab to open on. */
const ready = ref(false)

async function start(current: Icon) {
  word.value = null
  upload.value = null
  tab.value = current.kind === 'emoji' ? 'emoji' : current.kind === 'image' ? 'image' : 'icons'
  if (current.kind === 'image') {
    const image = await getImagesRepository()
      .get(current.image)
      .catch((e: unknown) => {
        console.warn('Could not read the icon’s picture.', e)
        return null
      })
    const settings = image ? wordFromSource(image.source) : null
    if (settings) {
      word.value = settings
      tab.value = 'text'
    } else if (image) {
      upload.value = { url: imageDataUrl(image), fills: image.source !== null }
    }
  }
}

watch(
  visible,
  async (open) => {
    ready.value = false
    if (!open) return
    await start(icon.value)
    if (visible.value) ready.value = true
  },
  { immediate: true },
)

function pick(next: Icon) {
  icon.value = next
  visible.value = false
}

const TABS: { name: TabName; label: string; icon: string }[] = [
  { name: 'icons', label: 'Icons', icon: 'pi pi-th-large' },
  { name: 'emoji', label: 'Emoji', icon: 'pi pi-face-smile' },
  { name: 'text', label: 'Text', icon: 'pi pi-pencil' },
  { name: 'image', label: 'Image', icon: 'pi pi-image' },
]
</script>

<template>
  <Dialog
    :visible="visible && ready"
    modal
    header="Choose an icon"
    :draggable="false"
    class="w-[42rem] max-w-[calc(100vw-2rem)] max-sm:m-0! max-sm:h-dvh! max-sm:max-h-dvh! max-sm:w-screen! max-sm:max-w-none! max-sm:rounded-none!"
    :pt="{ content: { class: 'flex min-h-0 flex-1 flex-col' } }"
    @update:visible="visible = $event"
    @after-hide="emit('after-hide')"
  >
    <Tabs v-model:value="tab" class="flex min-h-0 flex-1 flex-col">
      <TabList>
        <Tab v-for="t in TABS" :key="t.name" :value="t.name" class="flex items-center gap-2">
          <span :class="t.icon" aria-hidden="true" />
          <span>{{ t.label }}</span>
        </Tab>
      </TabList>
      <TabPanels class="min-h-0 flex-1 overflow-y-auto px-0! sm:h-[28rem] sm:flex-none">
        <TabPanel value="icons">
          <IconsTab :icon="icon" @pick="pick" />
        </TabPanel>
        <TabPanel value="emoji" class="h-full">
          <EmojiTab :active="tab === 'emoji'" @pick="pick" />
        </TabPanel>
        <TabPanel value="text">
          <TextTab
            :start="word"
            :colour="props.colour"
            :fallback="props.fallback"
            :active="tab === 'text'"
            @pick="pick"
          />
        </TabPanel>
        <TabPanel value="image">
          <ImageTab
            :current="upload"
            :colour="props.colour"
            :fallback="props.fallback"
            :active="tab === 'image'"
            @pick="pick"
          />
        </TabPanel>
      </TabPanels>
    </Tabs>
  </Dialog>
</template>
