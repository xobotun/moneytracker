<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import RadioButton from 'primevue/radiobutton'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import DatePicker from 'primevue/datepicker'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useTagsStore } from '@/stores/tags'
import { MergeConflictError, TagLoopError } from '@/db/errors'
import type { ShortId } from '@/db/shortId'
import type { Tag, TagDetailConflict, TagDetailField, TagDetailValues } from '@/db/types'
import { effectiveLook, type TagLook } from '@/tags/look'
import { namesAddedByMerge } from '@/tags/otherNames'
import { pathLabel, subtreeIds, tagOptions, tagPath } from '@/tags/tree'
import { KIND_NOUNS } from './tagForm'
import TagOptionLabel from './TagOptionLabel.vue'
import TagChip from './TagChip.vue'
import NamePills from './NamePills.vue'
import { formatMetres } from '@/format/distance'
import { answerError, emptyAnswer, typedValue, type Answer } from './mergeForm'

/** Merges `source` into a tag the user picks (decisions §2.5). */
const props = defineProps<{ source: Tag }>()
const visible = defineModel<boolean>('visible', { required: true })
const emit = defineEmits<{ merged: [] }>()

const FIELD_LABELS: Record<TagDetailField, string> = {
  address: 'Address',
  position: 'Position',
  radius_metres: 'Radius',
  auto_match: 'Automatic matching',
  merchant_id: 'Merchant',
  default_category_id: 'Default category',
  start_date: 'Start date',
  end_date: 'End date',
}

const store = useTagsStore()
const noun = computed(() => KIND_NOUNS[props.source.kind])
const nouns = computed(() => (noun.value === 'category' ? 'categories' : `${noun.value}s`))

const targetId = ref<ShortId | null>(null)
const uses = ref<number | null>(null)
const conflicts = ref<TagDetailConflict[]>([])
const answers = ref<Partial<Record<TagDetailField, Answer>>>({})
const checking = ref(false)
const merging = ref(false)
const error = ref<string | null>(null)

watch(
  visible,
  (open) => {
    if (open) void reset()
  },
  { immediate: true },
)

async function reset() {
  targetId.value = null
  conflicts.value = []
  answers.value = {}
  error.value = null
  uses.value = null
  try {
    uses.value = await store.usageCount(props.source.id)
  } catch (e) {
    error.value = `Could not count the uses of “${props.source.name}”. ${(e as Error).message}`
  }
}

const targetOptions = computed(() =>
  tagOptions(store.tags, props.source.kind, subtreeIds(props.source.id, store.tags)),
)
const target = computed(() =>
  targetId.value === null ? undefined : store.byId.get(targetId.value),
)
const targetLabel = computed(() =>
  target.value ? pathLabel(tagPath(target.value, store.byId)) : '',
)
/** The two tags as the warning shows them: the source by its name, the target by its path. */
const sourceChip = computed(() => ({
  label: props.source.name,
  ...effectiveLook(props.source, store.byId),
}))
const targetChip = computed(() =>
  target.value ? { label: targetLabel.value, ...effectiveLook(target.value, store.byId) } : null,
)
/** The names the merge adds to the target's other names (as `TagsRepository.merge` does). */
const addedNames = computed(() =>
  target.value ? namesAddedByMerge(props.source, target.value) : [],
)
const childCount = computed(
  () =>
    store.tags.filter((t) => t.parent_id === props.source.id && t.deleted_at_utc === null).length,
)

watch(targetId, () => void readConflicts())

async function readConflicts() {
  conflicts.value = []
  answers.value = {}
  error.value = null
  if (targetId.value === null) return
  checking.value = true
  try {
    conflicts.value = await store.detailConflicts(props.source.id, targetId.value)
    answers.value = Object.fromEntries(conflicts.value.map((c) => [c.field, emptyAnswer()]))
  } catch (e) {
    error.value = `Could not compare the details. ${(e as Error).message}`
  } finally {
    checking.value = false
  }
}

/** A detail value as the user reads it. */
function shown(field: TagDetailField, value: TagDetailValues[TagDetailField]): string {
  if (value === null) return 'none'
  if (typeof value === 'object') return `${value.latitude}, ${value.longitude}`
  if (typeof value === 'number') return formatMetres(value)
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (field === 'merchant_id' || field === 'default_category_id') {
    const tag = store.byId.get(value as ShortId)
    if (!tag) return 'an unknown tag'
    const label = pathLabel(tagPath(tag, store.byId))
    return tag.deleted_at_utc === null ? label : `${label} (deleted)`
  }
  return value
}

/** The live tags a link may point to, with their look; 'None' has none. */
function linkOptions(
  field: TagDetailField,
): ({ id: ShortId | null; label: string } & Partial<TagLook>)[] {
  return [
    { id: null, label: 'None' },
    ...tagOptions(store.tags, field === 'merchant_id' ? 'merchant' : 'category'),
  ]
}

// Each differing detail needs a usable answer before the merge.
const answered = computed(() =>
  conflicts.value.every((c) => !answerError(c.field, answers.value[c.field]!)),
)
const canMerge = computed(
  () => target.value !== undefined && !checking.value && !merging.value && answered.value,
)

async function merge() {
  if (!canMerge.value || targetId.value === null) return
  const resolved: Partial<TagDetailValues> = {}
  for (const c of conflicts.value) {
    const a = answers.value[c.field]!
    const value =
      a.choice === 'source' ? c.source : a.choice === 'target' ? c.target : typedValue(c.field, a)
    ;(resolved as Record<TagDetailField, unknown>)[c.field] = value
  }
  merging.value = true
  error.value = null
  try {
    await store.merge(props.source.id, targetId.value, resolved)
    visible.value = false
    emit('merged')
  } catch (e) {
    if (e instanceof MergeConflictError) {
      await readConflicts()
      error.value = 'The details changed meanwhile (a sync?). Choose again.'
    } else if (e instanceof TagLoopError) {
      error.value = `A ${noun.value} cannot be merged into its own sub-${noun.value}: ${e.path.join(' > ')}.`
    } else {
      error.value = `Could not merge. ${(e as Error).message}`
    }
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="`Merge “${source.name}”`"
    :draggable="false"
    class="w-[34rem] max-w-[calc(100vw-2rem)]"
  >
    <form class="flex flex-col gap-5" novalidate @submit.prevent="merge">
      <div class="flex flex-col gap-1">
        <label for="merge-target" class="text-sm font-medium">Into</label>
        <Select
          v-model="targetId"
          input-id="merge-target"
          :options="targetOptions"
          option-label="label"
          option-value="id"
          :placeholder="`Choose a ${noun}`"
          filter
          fluid
        />
      </div>

      <!-- Short lines, the tags as chips and the names as pills, as on the Tags page. -->
      <div v-if="targetChip" class="flex flex-col gap-1 text-sm leading-6" role="status">
        <p><TagChip v-bind="sourceChip" in-text data-tag="source" /> will be deleted.</p>
        <p v-if="uses">
          Its {{ uses }} {{ uses === 1 ? 'use moves' : 'uses move' }} to
          <TagChip v-bind="targetChip" in-text data-tag="target" /><template
            v-if="source.kind === 'category'"
          >
            (parts of one transaction in both are added together)</template
          >.
        </p>
        <p v-if="childCount > 0">
          Its sub-{{ nouns }} move under <TagChip v-bind="targetChip" in-text data-tag="target" />.
        </p>
        <!-- The pills on a line of their own: a wrapped list would strand a full stop after it. -->
        <div v-if="addedNames.length > 0">
          <p>
            These names become other names of
            <TagChip v-bind="targetChip" in-text data-tag="target" />:
          </p>
          <NamePills data-names :names="addedNames" label="Names that move" class="mt-0.5 flex" />
        </div>
        <p v-else>
          Its names are already other names of
          <TagChip v-bind="targetChip" in-text data-tag="target" />.
        </p>
        <p>
          <TagChip v-bind="targetChip" in-text data-tag="target" /> keeps its colour, icon and
          description.
        </p>
      </div>
      <!-- Restoring refuses a merged tag (TagsRepository.restore): nothing in the app undoes it. -->
      <Message v-if="targetChip" severity="warn" :closable="false" size="small">
        A merge can't be undone: <TagChip v-bind="sourceChip" in-text /> can't be restored
        afterwards.
      </Message>

      <fieldset
        v-for="c in conflicts"
        :key="c.field"
        class="flex flex-col gap-2 rounded-md border border-gray-200 p-3 dark:border-gray-700"
      >
        <legend class="px-1 text-sm font-medium">
          {{ FIELD_LABELS[c.field] }}: the two differ
        </legend>
        <div class="flex items-center gap-2">
          <RadioButton
            v-model="answers[c.field]!.choice"
            :input-id="`merge-${c.field}-source`"
            :name="`merge-${c.field}`"
            value="source"
          />
          <label :for="`merge-${c.field}-source`">
            {{ shown(c.field, c.source) }} <span class="text-gray-500">({{ source.name }})</span>
          </label>
        </div>
        <div class="flex items-center gap-2">
          <RadioButton
            v-model="answers[c.field]!.choice"
            :input-id="`merge-${c.field}-target`"
            :name="`merge-${c.field}`"
            value="target"
          />
          <label :for="`merge-${c.field}-target`">
            {{ shown(c.field, c.target) }}
            <span class="text-gray-500">({{ target?.name }})</span>
          </label>
        </div>
        <!-- A flag has no third value. -->
        <div v-if="c.field !== 'auto_match'" class="flex items-center gap-2">
          <RadioButton
            v-model="answers[c.field]!.choice"
            :input-id="`merge-${c.field}-other`"
            :name="`merge-${c.field}`"
            value="other"
          />
          <label :for="`merge-${c.field}-other`">Another</label>
        </div>
        <template v-if="answers[c.field]!.choice === 'other'">
          <InputText
            v-if="c.field === 'address'"
            :id="`merge-${c.field}-value`"
            v-model="answers[c.field]!.text"
            aria-label="Another address"
          />
          <div v-else-if="c.field === 'position'" class="grid grid-cols-2 gap-2">
            <InputNumber
              v-model="answers[c.field]!.latitude"
              placeholder="Latitude"
              aria-label="Latitude"
              :max-fraction-digits="7"
              :use-grouping="false"
              fluid
            />
            <InputNumber
              v-model="answers[c.field]!.longitude"
              placeholder="Longitude"
              aria-label="Longitude"
              :max-fraction-digits="7"
              :use-grouping="false"
              fluid
            />
          </div>
          <InputNumber
            v-else-if="c.field === 'radius_metres'"
            v-model="answers[c.field]!.radius"
            placeholder="10"
            suffix=" m"
            aria-label="Another radius, in metres"
            :use-grouping="false"
            fluid
          />
          <Select
            v-else-if="c.field === 'merchant_id' || c.field === 'default_category_id'"
            v-model="answers[c.field]!.link"
            :options="linkOptions(c.field)"
            option-label="label"
            option-value="id"
            placeholder="None"
            :aria-label="`Another ${FIELD_LABELS[c.field].toLowerCase()}`"
            filter
            fluid
          >
            <template #value="{ value, placeholder }">
              <TagOptionLabel
                :option="linkOptions(c.field).find((o) => o.id === value)"
                :placeholder="placeholder"
              />
            </template>
            <template #option="{ option }">
              <TagOptionLabel :option="option" />
            </template>
          </Select>
          <DatePicker
            v-else
            v-model="answers[c.field]!.date"
            date-format="yy-mm-dd"
            :aria-label="`Another ${FIELD_LABELS[c.field].toLowerCase()}`"
            fluid
          />
          <small
            v-if="answers[c.field]!.choice === 'other' && answerError(c.field, answers[c.field]!)"
            class="text-red-600"
          >
            {{ answerError(c.field, answers[c.field]!) }}
          </small>
        </template>
      </fieldset>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <div class="flex justify-end gap-2">
        <Button type="button" label="Cancel" severity="secondary" text @click="visible = false" />
        <Button type="submit" label="Merge" :loading="merging" :disabled="!canMerge" />
      </div>
    </form>
  </Dialog>
</template>
