<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import AutoComplete from 'primevue/autocomplete'
import DatePicker from 'primevue/datepicker'
import Checkbox from 'primevue/checkbox'
import Button from 'primevue/button'
import Message from 'primevue/message'
import AccountBadge from '@/components/accounts/AccountBadge.vue'
import ColourPicker from '@/components/accounts/ColourPicker.vue'
import IconPicker from '@/components/accounts/IconPicker.vue'
import { DERIVED_CLASS } from '@/components/derived'
import { useTagsStore } from '@/stores/tags'
import { CategoryInUseError, DuplicateTagNameError, TagLoopError } from '@/db/errors'
import { DEFAULT_LOCATION_RADIUS_METRES, noDetails } from '@/db/repositories/TagDetailsRepository'
import LocationMap from './LocationMap.vue'
import type { LatLon } from './mapView'
import type { ShortId } from '@/db/shortId'
import type { Tag, TagKind } from '@/db/types'
import { inheritedLook } from '@/tags/look'
import { carriedNames, foldCase, mergedNames } from '@/tags/otherNames'
import { subtreeIds, tagOptions } from '@/tags/tree'
import {
  KIND_NOUNS,
  createInputFromDraft,
  detailDraft,
  draftFromTag,
  newTagDraft,
  saveInputFromDraft,
  validateDraft,
  type TagDraft,
  type TagDraftErrors,
} from './tagForm'

/**
 * Edits `tag`, or creates a new tag of `kind` under `parentId` when it is
 * null. `closeOnEscape` is off while a dialog stacked on top of this one is
 * open: every open dialog hears Escape, and only the top one should close.
 */
const props = withDefaults(
  defineProps<{
    kind: TagKind
    tag: Tag | null
    parentId?: ShortId | null
    closeOnEscape?: boolean
  }>(),
  { parentId: null, closeOnEscape: true },
)
const visible = defineModel<boolean>('visible', { required: true })
/** Asks for the merge dialog for this tag (the page stacks it over this one). */
const emit = defineEmits<{ merge: [tag: Tag] }>()

const store = useTagsStore()
const noun = computed(() => KIND_NOUNS[props.kind])

const draft = ref<TagDraft>(newTagDraft(props.kind, null))
// The names the tags merged into this one carry, as the dialog opened (see otherNames.ts).
const carried = ref<string[]>([])
// A journey's dates as derived from its transactions: what a reset goes back to.
const derivedDates = ref<{ start: string | null; end: string | null }>({ start: null, end: null })
const loading = ref(false)
// The details could not be read: saving the empty draft would wipe them.
const loadFailed = ref(false)
const submitted = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const confirmingDelete = ref(false)
// Live transactions and accounts using the tag; read when Delete is pressed.
const uses = ref(0)
const locating = ref(false)
const positionError = ref<string | null>(null)
// A location's map opens where its nearest placed ancestor is, once that is known.
const mapFallback = ref<LatLon | null>(null)
const mapReady = ref(false)

// Counts openings, so details read for an earlier one are dropped.
let opening = 0

// Start from a fresh draft each time the dialog opens.
watch(
  visible,
  (open) => {
    if (open) void reset()
  },
  { immediate: true },
)

async function reset() {
  const current = ++opening
  submitted.value = false
  error.value = null
  loadFailed.value = false
  loading.value = false
  confirmingDelete.value = false
  positionError.value = null
  derivedDates.value = { start: null, end: null }
  mapReady.value = false
  mapFallback.value = null
  const tag = props.tag
  if (!tag) {
    draft.value = newTagDraft(props.kind, props.parentId)
    carried.value = []
    void prepareMap(current, props.parentId)
    return
  }
  carried.value = carriedNames(tag.id, store.tags)
  // The tag's own fields at once; its details follow when read (the user
  // may type meanwhile, so they fill only the detail fields).
  draft.value = draftFromTag(tag, noDetails(), mergedNames(tag, store.tags))
  loading.value = true
  try {
    const details = await store.details(tag)
    if (current !== opening) return
    Object.assign(draft.value, detailDraft(details))
    void prepareMap(current, tag.parent_id)
    if (tag.kind === 'journey') {
      const dates = await store.journeyDates(tag.id)
      if (current !== opening) return
      derivedDates.value = { start: dates.derivedStart, end: dates.derivedEnd }
    }
  } catch (e) {
    if (current !== opening) return
    loadFailed.value = true
    error.value = `Could not load the ${noun.value}'s details. ${(e as Error).message}`
  } finally {
    if (current === opening) loading.value = false
  }
}

/** Finds the position the map opens on when the location has none: the nearest placed ancestor's. */
async function prepareMap(current: number, parentId: ShortId | null) {
  if (props.kind !== 'location') return
  let fallback: LatLon | null = null
  try {
    const seen = new Set<ShortId>()
    for (let id = parentId; id !== null && !seen.has(id); ) {
      seen.add(id)
      const ancestor = store.byId.get(id)
      if (!ancestor) break
      const position = (await store.details(ancestor)).position
      if (position) {
        fallback = position
        break
      }
      id = ancestor.parent_id
    }
  } catch {
    // No ancestor to open on: the map opens on the whole world.
  }
  if (current !== opening) return
  mapFallback.value = fallback
  mapReady.value = true
}

function pickOnMap(latitude: number, longitude: number) {
  draft.value.latitude = latitude
  draft.value.longitude = longitude
  positionError.value = null
}

const errors = computed(() => validateDraft(draft.value))
// Errors appear only after the first save attempt, not while typing.
const shownErrors = computed<TagDraftErrors>(() => (submitted.value ? errors.value : {}))

// --- Parent and links: live tags by path ---

const parentOptions = computed(() => [
  { id: null, label: 'None (top level)' },
  ...tagOptions(
    store.tags,
    props.kind,
    props.tag ? subtreeIds(props.tag.id, store.tags) : undefined,
  ),
])

/** Live tags of `kind`, plus the one linked now when it is deleted (saving keeps that link). */
function linkOptions(kind: TagKind, linked: ShortId | null) {
  const options: { id: ShortId | null; label: string }[] = [
    { id: null, label: 'None' },
    ...tagOptions(store.tags, kind),
  ]
  const tag = linked === null ? undefined : store.byId.get(linked)
  if (tag && tag.deleted_at_utc !== null) {
    options.push({ id: tag.id, label: `${tag.name} (deleted)` })
  }
  return options
}
const merchantOptions = computed(() => linkOptions('merchant', draft.value.merchant_id))
const categoryOptions = computed(() => linkOptions('category', draft.value.default_category_id))

// --- Colour and icon: inherited ones are derived values ---

const inherited = computed(() =>
  inheritedLook(props.kind, draft.value.parent_id, props.tag?.id ?? null, store.byId),
)
const shownColour = computed({
  get: () => draft.value.colour ?? inherited.value.colour,
  set: (colour: string) => (draft.value.colour = colour),
})
const shownIcon = computed({
  get: () => draft.value.icon ?? inherited.value.icon,
  set: (icon: string) => (draft.value.icon = icon),
})
const lookSource = (from: Tag | null) => (from ? `from ${from.name}` : 'the default')
const colourSource = computed(() => lookSource(inherited.value.colourFrom))
const iconSource = computed(() => lookSource(inherited.value.iconFrom))

// --- Other names ---

// The listed names that came from merges: removing one retires it.
const mergedShown = computed(() => {
  const keys = new Set(carried.value.map(foldCase))
  return draft.value.otherNames.filter((name) => keys.has(foldCase(name)))
})

// --- Location position ---

function usePosition() {
  positionError.value = null
  if (!('geolocation' in navigator)) {
    positionError.value = 'This device cannot tell its position.'
    return
  }
  locating.value = true
  navigator.geolocation.getCurrentPosition(
    (position) => {
      // Six decimals are about 10 cm: more than a phone can tell.
      draft.value.latitude = Number(position.coords.latitude.toFixed(6))
      draft.value.longitude = Number(position.coords.longitude.toFixed(6))
      locating.value = false
    },
    (failure) => {
      positionError.value = `Could not get the position. ${failure.message}`
      locating.value = false
    },
    { enableHighAccuracy: true, timeout: 20_000 },
  )
}

// --- Journey dates: derived until typed ---

function toDate(iso: string | null): Date | null {
  if (iso === null) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function toIso(date: Date | null): string | null {
  if (!date) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const startDate = computed({
  get: () => toDate(draft.value.start_date ?? derivedDates.value.start),
  set: (date: Date | null) => (draft.value.start_date = toIso(date)),
})
const endDate = computed({
  get: () => toDate(draft.value.end_date ?? derivedDates.value.end),
  set: (date: Date | null) => (draft.value.end_date = toIso(date)),
})
const DATES_SOURCE = 'From its transactions and the journeys under it'

// --- Save, delete, merge ---

function saveError(e: unknown): string {
  if (e instanceof DuplicateTagNameError) {
    return `Another ${noun.value} at this level is already called “${e.tagName}”. To make them one ${noun.value}, open one of them and use “Merge into…”.`
  }
  if (e instanceof TagLoopError) {
    return `A ${noun.value} cannot go under its own sub-${noun.value}: ${e.path.join(' > ')}.`
  }
  return `Could not save the ${noun.value}. ${(e as Error).message}`
}

async function save() {
  if (loading.value || loadFailed.value) return
  submitted.value = true
  if (Object.keys(errors.value).length > 0) return
  saving.value = true
  error.value = null
  try {
    if (props.tag) await store.save(props.tag.id, saveInputFromDraft(draft.value))
    else await store.create(createInputFromDraft(props.kind, draft.value))
    visible.value = false
  } catch (e) {
    error.value = saveError(e)
  } finally {
    saving.value = false
  }
}

const childCount = computed(
  () => store.tags.filter((t) => t.parent_id === props.tag?.id && t.deleted_at_utc === null).length,
)
// A category in use cannot be deleted: every transaction needs one (§2.5).
const mustMerge = computed(() => props.kind === 'category' && uses.value > 0)

async function askDelete() {
  if (!props.tag) return
  error.value = null
  try {
    uses.value = await store.usageCount(props.tag.id)
    confirmingDelete.value = true
  } catch (e) {
    error.value = `Could not count the ${noun.value}'s uses. ${(e as Error).message}`
  }
}

async function remove() {
  if (!props.tag) return
  saving.value = true
  error.value = null
  try {
    await store.remove(props.tag.id)
    visible.value = false
  } catch (e) {
    error.value =
      e instanceof CategoryInUseError
        ? `Every transaction needs a category, so a category in use can only be merged into another one.`
        : `Could not delete the ${noun.value}. ${(e as Error).message}`
    confirmingDelete.value = false
  } finally {
    saving.value = false
  }
}

function merge() {
  if (props.tag) emit('merge', props.tag)
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="`${tag ? 'Edit' : 'New'} ${noun}`"
    :draggable="false"
    :close-on-escape="closeOnEscape"
    class="w-[34rem] max-w-[calc(100vw-2rem)]"
  >
    <form class="flex flex-col gap-5" novalidate @submit.prevent="save">
      <div class="flex items-start gap-3">
        <AccountBadge :icon="shownIcon" :colour="shownColour" large class="mt-6" />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label for="tag-name" class="text-sm font-medium">Name</label>
          <InputText
            id="tag-name"
            v-model="draft.name"
            autofocus
            maxlength="60"
            autocomplete="off"
            :invalid="!!shownErrors.name"
            :aria-describedby="shownErrors.name ? 'tag-name-error' : undefined"
          />
          <small v-if="shownErrors.name" id="tag-name-error" class="text-red-600">
            {{ shownErrors.name }}
          </small>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <label for="tag-parent" class="text-sm font-medium">Under</label>
        <Select
          v-model="draft.parent_id"
          input-id="tag-parent"
          :options="parentOptions"
          option-label="label"
          option-value="id"
          placeholder="None (top level)"
          filter
          fluid
        />
      </div>

      <div class="flex flex-col gap-1">
        <label for="tag-other-names" class="text-sm font-medium">Other names</label>
        <AutoComplete
          v-model="draft.otherNames"
          input-id="tag-other-names"
          multiple
          :typeahead="false"
          fluid
          :pt="{ input: { 'aria-describedby': 'tag-other-names-hint' } }"
        />
        <small id="tag-other-names-hint" class="text-gray-500 dark:text-gray-400">
          Optional. Each finds the {{ noun }} too; type one and press Enter.
          <template v-if="mergedShown.length > 0">
            {{ mergedShown.join(', ') }} came from {{ noun }}s merged into this one; removing one
            stops it finding this {{ noun }}.
          </template>
        </small>
      </div>

      <div class="flex flex-col gap-1">
        <label for="tag-description" class="text-sm font-medium">Description</label>
        <Textarea id="tag-description" v-model="draft.description" rows="2" auto-resize fluid />
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium">Colour</span>
        <div
          :class="draft.colour === null ? DERIVED_CLASS : undefined"
          :title="draft.colour === null ? `Inherited: ${colourSource}` : undefined"
        >
          <ColourPicker v-model="shownColour" />
        </div>
        <div class="flex min-h-8 items-center gap-2 text-sm">
          <span v-if="draft.colour === null" :class="DERIVED_CLASS">
            Inherited: {{ colourSource }}
          </span>
          <Button
            v-else
            type="button"
            label="Reset"
            icon="pi pi-undo"
            severity="secondary"
            text
            size="small"
            :aria-label="`Use the colour ${colourSource}`"
            @click="draft.colour = null"
          />
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium">Icon</span>
        <div
          :class="draft.icon === null ? DERIVED_CLASS : undefined"
          :title="draft.icon === null ? `Inherited: ${iconSource}` : undefined"
        >
          <IconPicker v-model="shownIcon" />
        </div>
        <div class="flex min-h-8 items-center gap-2 text-sm">
          <span v-if="draft.icon === null" :class="DERIVED_CLASS">Inherited: {{ iconSource }}</span>
          <Button
            v-else
            type="button"
            label="Reset"
            icon="pi pi-undo"
            severity="secondary"
            text
            size="small"
            :aria-label="`Use the icon ${iconSource}`"
            @click="draft.icon = null"
          />
        </div>
      </div>

      <template v-if="kind === 'location'">
        <div class="flex flex-col gap-1">
          <label for="tag-address" class="text-sm font-medium">Address</label>
          <InputText id="tag-address" v-model="draft.address" autocomplete="off" />
        </div>
        <fieldset class="flex flex-col gap-1">
          <legend class="mb-1 text-sm font-medium">Position</legend>
          <div class="grid grid-cols-2 gap-2">
            <InputNumber
              v-model="draft.latitude"
              input-id="tag-latitude"
              placeholder="Latitude"
              :max-fraction-digits="7"
              :use-grouping="false"
              :invalid="!!shownErrors.position"
              aria-label="Latitude"
              fluid
            />
            <InputNumber
              v-model="draft.longitude"
              input-id="tag-longitude"
              placeholder="Longitude"
              :max-fraction-digits="7"
              :use-grouping="false"
              :invalid="!!shownErrors.position"
              aria-label="Longitude"
              fluid
            />
          </div>
          <small v-if="shownErrors.position" class="text-red-600">{{ shownErrors.position }}</small>
          <small v-if="positionError" class="text-red-600">{{ positionError }}</small>
          <div>
            <Button
              type="button"
              label="Use my position"
              icon="pi pi-map-marker"
              severity="secondary"
              text
              size="small"
              :loading="locating"
              @click="usePosition"
            />
          </div>
          <LocationMap
            v-if="mapReady"
            :latitude="draft.latitude"
            :longitude="draft.longitude"
            :radius="draft.radius_metres ?? DEFAULT_LOCATION_RADIUS_METRES"
            :fallback="mapFallback"
            @pick="pickOnMap"
          />
        </fieldset>
        <div class="flex flex-col gap-1">
          <label for="tag-radius" class="text-sm font-medium">Radius</label>
          <InputNumber
            v-model="draft.radius_metres"
            input-id="tag-radius"
            suffix=" m"
            placeholder="10 m"
            :use-grouping="false"
            :invalid="!!shownErrors.radius"
            aria-describedby="tag-radius-hint"
            fluid
          />
          <small v-if="shownErrors.radius" class="text-red-600">{{ shownErrors.radius }}</small>
          <small v-else id="tag-radius-hint" class="text-gray-500 dark:text-gray-400">
            How far around the position still counts as this place; 10 m when empty.
          </small>
        </div>
        <div class="flex items-start gap-2">
          <Checkbox v-model="draft.auto_match" input-id="tag-auto-match" binary class="mt-0.5" />
          <div class="flex flex-col">
            <label for="tag-auto-match" class="text-sm font-medium">
              Match transactions here automatically
            </label>
            <small class="text-gray-500 dark:text-gray-400">
              Turn off for a place that moves or closes, like a weekly market: it is still offered
              nearby, but never filled in by itself.
            </small>
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <label for="tag-merchant" class="text-sm font-medium">Merchant</label>
          <Select
            v-model="draft.merchant_id"
            input-id="tag-merchant"
            :options="merchantOptions"
            option-label="label"
            option-value="id"
            placeholder="None"
            filter
            fluid
          />
        </div>
      </template>

      <div v-if="kind === 'merchant'" class="flex flex-col gap-1">
        <label for="tag-default-category" class="text-sm font-medium">Default category</label>
        <Select
          v-model="draft.default_category_id"
          input-id="tag-default-category"
          :options="categoryOptions"
          option-label="label"
          option-value="id"
          placeholder="None"
          filter
          fluid
        />
      </div>

      <fieldset v-if="kind === 'journey'" class="flex flex-col gap-1">
        <legend class="mb-1 text-sm font-medium">Dates</legend>
        <div class="grid grid-cols-2 gap-2">
          <div class="flex flex-col gap-1">
            <div
              :class="draft.start_date === null ? DERIVED_CLASS : undefined"
              :title="draft.start_date === null && startDate ? DATES_SOURCE : undefined"
            >
              <DatePicker
                v-model="startDate"
                input-id="tag-start-date"
                date-format="yy-mm-dd"
                placeholder="Start"
                aria-label="Start date"
                :invalid="!!shownErrors.dates"
                fluid
              />
            </div>
            <div class="min-h-8">
              <Button
                v-if="draft.start_date !== null"
                type="button"
                label="Reset"
                icon="pi pi-undo"
                severity="secondary"
                text
                size="small"
                aria-label="Use the start date from its transactions"
                @click="draft.start_date = null"
              />
            </div>
          </div>
          <div class="flex flex-col gap-1">
            <div
              :class="draft.end_date === null ? DERIVED_CLASS : undefined"
              :title="draft.end_date === null && endDate ? DATES_SOURCE : undefined"
            >
              <DatePicker
                v-model="endDate"
                input-id="tag-end-date"
                date-format="yy-mm-dd"
                placeholder="End"
                aria-label="End date"
                :invalid="!!shownErrors.dates"
                fluid
              />
            </div>
            <div class="min-h-8">
              <Button
                v-if="draft.end_date !== null"
                type="button"
                label="Reset"
                icon="pi pi-undo"
                severity="secondary"
                text
                size="small"
                aria-label="Use the end date from its transactions"
                @click="draft.end_date = null"
              />
            </div>
          </div>
        </div>
        <small v-if="shownErrors.dates" class="text-red-600">{{ shownErrors.dates }}</small>
        <small v-else class="text-gray-500 dark:text-gray-400">
          Taken from its transactions until you type a date.
        </small>
      </fieldset>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <div
        v-if="confirmingDelete && tag"
        class="flex flex-col gap-3 rounded-md border border-red-300 p-3 dark:border-red-800"
        role="alert"
      >
        <template v-if="mustMerge">
          <p>
            Every transaction needs a category, so a category in use can only be merged into another
            one. “{{ tag.name }}” is used {{ uses }} time{{ uses === 1 ? '' : 's' }}.
          </p>
          <div class="flex justify-end gap-2">
            <Button
              type="button"
              label="Keep it"
              severity="secondary"
              text
              @click="confirmingDelete = false"
            />
            <Button type="button" label="Merge into…" @click="merge" />
          </div>
        </template>
        <template v-else>
          <p>
            Delete “{{ tag.name }}”?
            <template v-if="uses > 0">
              Used by {{ uses }} transaction{{ uses === 1 ? '' : 's' }} or account{{
                uses === 1 ? '' : 's'
              }}: they keep it, hidden, and get it back if you restore it.
            </template>
            <template v-if="childCount > 0">Its sub-{{ noun }}s move up one level.</template>
          </p>
          <div class="flex justify-end gap-2">
            <Button
              type="button"
              label="Keep it"
              severity="secondary"
              text
              @click="confirmingDelete = false"
            />
            <Button
              type="button"
              :label="`Delete ${noun}`"
              severity="danger"
              :loading="saving"
              @click="remove"
            />
          </div>
        </template>
      </div>
      <div v-else class="flex flex-wrap items-center gap-2">
        <Button
          v-if="tag"
          type="button"
          label="Delete"
          icon="pi pi-trash"
          severity="danger"
          text
          :aria-label="`Delete ${tag.name}`"
          :pt="{ label: { class: 'hidden sm:inline' } }"
          :disabled="saving || loading"
          @click="askDelete"
        />
        <Button
          v-if="tag"
          type="button"
          label="Merge into…"
          icon="pi pi-arrow-right-arrow-left"
          severity="secondary"
          text
          :aria-label="`Merge ${tag.name} into another ${noun}`"
          :pt="{ label: { class: 'hidden sm:inline' } }"
          :disabled="saving || loading"
          @click="merge"
        />
        <span class="flex-1" />
        <Button type="button" label="Cancel" severity="secondary" text @click="visible = false" />
        <Button
          type="submit"
          :label="tag ? 'Save' : `Add ${noun}`"
          :loading="saving"
          :disabled="loading || loadFailed"
        />
      </div>
    </form>
  </Dialog>
</template>
