<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Card from 'primevue/card'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputText from 'primevue/inputtext'
import ToggleSwitch from 'primevue/toggleswitch'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import IconBadge from '@/components/icons/IconBadge.vue'
import TagTreeRow from '@/components/tags/TagTreeRow.vue'
import TagEditDialog from '@/components/tags/TagEditDialog.vue'
import TagMergeDialog from '@/components/tags/TagMergeDialog.vue'
import LocationsMap from '@/components/tags/LocationsMap.vue'
import TagOptionLabel from '@/components/tags/TagOptionLabel.vue'
import { KIND_NOUNS, KIND_PLURALS } from '@/components/tags/tagForm'
import { useTagsStore } from '@/stores/tags'
import type { ShortId } from '@/db/shortId'
import type { Tag, TagKind } from '@/db/types'
import { KIND_ICONS, effectiveLook } from '@/tags/look'
import { setIconClass } from '@/icons/sets'
import { mergedNamesByTag } from '@/tags/otherNames'
import { mapLocations } from '@/tags/locationsMap'
import { byJourneyDate, effectiveCurrency } from '@/tags/journeys'
import {
  buildTree,
  filterTree,
  flattenTree,
  heldOption,
  linkFilter,
  pathLabel,
  tagMatches,
  tagOptions,
  tagPath,
  type LinkChoice,
  type RowFact,
  type RowLink,
} from '@/tags/tree'
import { useLayoutStore, type TagRowStyle } from '@/stores/layout'
import { formatDay } from '@/format/date'
import { formatMetres } from '@/format/distance'
import { DEFAULT_LOCATION_RADIUS_METRES } from '@/db/repositories/TagDetailsRepository'

const KINDS: readonly TagKind[] = ['category', 'merchant', 'location', 'journey', 'tag']
const TAB_LABELS: Record<TagKind, string> = {
  category: 'Categories',
  merchant: 'Merchants',
  location: 'Locations',
  journey: 'Journeys',
  tag: 'Tags',
}
// What each kind is for (decisions §1), for an empty tab.
const KIND_HINTS: Record<TagKind, string> = {
  category:
    'What kind of spending or income a transaction is: Food › Groceries, Salary. Every transaction has one.',
  merchant: 'Who was paid, or who paid: Rewe, Amazon.',
  location: 'Where you paid, down to a single store: Germany › Berlin › Rewe Alexanderplatz.',
  journey: 'Trips and stays, like Summer 2026 › Lisbon, to see what each one cost.',
  tag: 'Anything else to slice by, like #birthday or #mia. A transaction can have many.',
}

const store = useTagsStore()
const route = useRoute()
const router = useRouter()
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)

onMounted(async () => {
  try {
    await store.load()
  } catch (e) {
    loadError.value = `Could not load the tags. ${(e as Error).message}`
  }
})

// The open tab lives in the URL (?kind=merchant), so a link or a reload keeps it.
const kind = computed<TagKind>(() => {
  const asked = route.query.kind
  return KINDS.find((k) => k === asked) ?? 'category'
})
function openTab(next: string | number) {
  void router.replace({ query: { ...route.query, kind: String(next) } })
}
const noun = computed(() => KIND_NOUNS[kind.value])
const nouns = computed(() => KIND_PLURALS[kind.value])

// --- The tree ---

const query = ref('')
const collapsed = ref(new Set<ShortId>())

// The dropdown beside the filter on the tabs whose tags link to another one:
// locations by their merchant, merchants by their default category (or one
// of its sub-categories). Page state, like the filter text.
const LINK_FILTERS: Partial<
  Record<TagKind, { kind: TagKind; noun: string; any: string; none: string; subtree: boolean }>
> = {
  location: {
    kind: 'merchant',
    noun: 'merchant',
    any: 'Any merchant',
    none: 'No merchant',
    subtree: false,
  },
  merchant: {
    kind: 'category',
    noun: 'category',
    any: 'Any category',
    none: 'No default category',
    subtree: true,
  },
}
const linkChoice = ref<LinkChoice>('any')
const linkSpec = computed(() => LINK_FILTERS[kind.value])
// A chosen tag archived or deleted since stays shown, labelled so.
const linkChoices = computed(() => {
  const spec = linkSpec.value
  if (!spec) return []
  const chosen = linkChoice.value
  const held = chosen === 'any' || chosen === 'none' ? null : heldOption(chosen, store.byId)
  return [
    { id: 'any', label: spec.any },
    { id: 'none', label: spec.none },
    ...tagOptions(store.tags, spec.kind),
    ...(held ? [held] : []),
  ]
})
const linkKeeps = computed(() => {
  const spec = linkSpec.value
  return spec
    ? linkFilter(linkChoice.value, store.detailLinks, store.tags, spec.subtree)
    : () => true
})

watch(kind, () => {
  query.value = ''
  linkChoice.value = 'any'
  actionError.value = null
})

const merged = computed(() => mergedNamesByTag(store.tags))
const otherNames = (tag: Tag) => [...tag.synonyms, ...(merged.value.get(tag.id) ?? [])]

// What a merchant or location links to, shown on its row as plain text.
const LINK_ROLES: Partial<Record<TagKind, string>> = {
  merchant: 'default category',
  location: 'merchant',
}
function linkOf(tag: Tag): RowLink | null {
  const role = LINK_ROLES[tag.kind]
  const id = store.detailLinks.get(tag.id)
  const linked = id === undefined ? undefined : store.byId.get(id)
  if (!role || !linked) return null
  return {
    role,
    label: pathLabel(tagPath(linked, store.byId)),
    look: effectiveLook(linked, store.byId),
    deleted: linked.deleted_at_utc !== null,
  }
}
// --- Row style: slim one-line rows, or every detail; or, for locations, a map ---
// (per device, see the layout store)

const layout = useLayoutStore()
const detailed = computed(() => layout.tagRows === 'detailed')
const onMap = computed(() => kind.value === 'location' && layout.locationsView === 'map')
type Display = TagRowStyle | 'map'
const ROW_STYLES: { value: Display; label: string; icon: string }[] = [
  { value: 'slim', label: 'Slim', icon: 'pi pi-bars' },
  { value: 'detailed', label: 'Detailed', icon: 'pi pi-align-left' },
]
const displays = computed(() =>
  kind.value === 'location'
    ? [...ROW_STYLES, { value: 'map' as const, label: 'Map', icon: 'pi pi-map' }]
    : ROW_STYLES,
)
const display = computed<Display>(() => (onMap.value ? 'map' : layout.tagRows))
async function setDisplay(choice: Display | null) {
  if (choice === null) return // one is always chosen
  actionError.value = null
  try {
    if (choice === 'map') await layout.setLocationsView('map')
    else {
      await Promise.all([
        layout.setTagRows(choice),
        kind.value === 'location' ? layout.setLocationsView('list') : undefined,
      ])
    }
  } catch (e) {
    actionError.value = `Could not keep the view on this device. ${(e as Error).message}`
  }
}

// A journey's dates, derived from its transactions until typed: read with
// the tags, every journey in one query.
const journeyDates = computed(() => store.journeyDatesById)

/**
 * What a detailed row lists under the names: a location's place, a journey's
 * dates and currency, and when a location or merchant is not matched
 * automatically.
 */
function factsOf(tag: Tag): RowFact[] {
  if (tag.kind === 'location') {
    const d = store.detailsById.get(tag.id)
    if (!d) return []
    const facts: RowFact[] = []
    if (d.address) facts.push({ text: d.address, derived: false })
    else if (d.position) {
      facts.push({ text: `${d.position.latitude}, ${d.position.longitude}`, derived: false })
    }
    if (d.position) {
      const radius = d.radius_metres ?? DEFAULT_LOCATION_RADIUS_METRES
      facts.push({ text: `within ${formatMetres(radius)}`, derived: false })
    }
    if (d.auto_match === false) facts.push({ text: 'not matched automatically', derived: false })
    return facts
  }
  if (tag.kind === 'merchant') {
    const d = store.detailsById.get(tag.id)
    return d?.auto_match === false ? [{ text: 'not matched automatically', derived: false }] : []
  }
  if (tag.kind === 'journey') {
    const facts: RowFact[] = []
    const dates = journeyDates.value.get(tag.id)
    const source = 'From its transactions and the journeys under it'
    if (dates?.start) {
      facts.push({
        text: `from ${formatDay(dates.start)}`,
        derived: !dates.startTyped,
        title: dates.startTyped ? undefined : source,
      })
    }
    if (dates?.end) {
      facts.push({
        text: `to ${formatDay(dates.end)}`,
        derived: !dates.endTyped,
        title: dates.endTyped ? undefined : source,
      })
    }
    const { currency, from } = effectiveCurrency(tag, store.byId, store.detailsById)
    if (currency !== null) {
      const inherited = from !== null && from.id !== tag.id
      facts.push({
        text: `in ${currency}`,
        derived: inherited,
        title: inherited ? `Inherited from ${from.name}` : undefined,
      })
    }
    return facts
  }
  return []
}

// --- Archived tags: left out unless "Show archived" is on for the tab ---

const showingArchived = ref(new Set<TagKind>())
const showArchived = computed({
  get: () => showingArchived.value.has(kind.value),
  set: (on: boolean) => {
    const next = new Set(showingArchived.value)
    if (on) next.add(kind.value)
    else next.delete(kind.value)
    showingArchived.value = next
  },
})
const archivedCount = computed(
  () =>
    store.tags.filter(
      (t) => t.kind === kind.value && t.deleted_at_utc === null && t.archived_at_utc !== null,
    ).length,
)

// The live tree, archived tags included; the page shows the tags the filter
// lets through with their ancestors, so an archived tag with active children
// stays as their (faint) parent.
// Journeys go by date, the newest first; the other kinds by name.
const tree = computed(() =>
  buildTree(
    store.tags,
    kind.value,
    kind.value === 'journey' ? byJourneyDate(journeyDates.value) : undefined,
  ),
)
const typed = computed(() => query.value.trim() !== '')
const filtering = computed(() => typed.value || linkChoice.value !== 'any')
const shows = (t: Tag) =>
  (showArchived.value || t.archived_at_utc === null) &&
  tagMatches(t, query.value, merged.value.get(t.id) ?? []) &&
  linkKeeps.value(t)
const nothingMatches = computed(() => {
  const chosen = linkChoice.value === 'any' ? null : `the ${linkSpec.value?.noun} chosen`
  if (!typed.value) return `No ${nouns.value} with ${chosen}.`
  return `Nothing matches “${query.value}”${chosen ? ` with ${chosen}` : ''}.`
})
const shownTree = computed(() => filterTree(tree.value, shows))
// While filtering every branch is open, so each match shows.
const rows = computed(() =>
  flattenTree(shownTree.value, (id) => filtering.value || !collapsed.value.has(id)),
)

// The map: every placed location the filter lets through, and a count of the
// ones it leaves off for want of a position. Worked out only while shown.
const located = computed(() =>
  onMap.value ? mapLocations(store.tags, store.detailsById, shows) : { shown: [], unplaced: 0 },
)

function toggle(id: ShortId) {
  const next = new Set(collapsed.value)
  if (!next.delete(id)) next.add(id)
  collapsed.value = next
}

const hasDuplicates = computed(() =>
  store.tags.some((t) => t.kind === kind.value && store.duplicateIds.has(t.id)),
)

// --- Deleted tags (merged ones are never listed: they cannot come back) ---

const showDeleted = ref(false)
const deletedTags = computed(() =>
  store.tags
    .filter((t) => t.kind === kind.value && t.deleted_at_utc !== null && t.merged_into_id === null)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
)
/** "was under Food" while that parent is still there. */
function formerParent(tag: Tag): string | null {
  const parent = tag.parent_id === null ? undefined : store.byId.get(tag.parent_id)
  return parent && parent.deleted_at_utc === null ? parent.name : null
}

async function restore(tag: Tag) {
  actionError.value = null
  try {
    await store.restore(tag.id)
  } catch (e) {
    actionError.value = `Could not restore “${tag.name}”. ${(e as Error).message}`
  }
}

// --- Dialogs ---

const editVisible = ref(false)
const editing = ref<{ tag: Tag | null; parentId: ShortId | null }>({ tag: null, parentId: null })
const mergeVisible = ref(false)
const mergeSource = ref<Tag | null>(null)

function openAdd(parentId: ShortId | null) {
  editing.value = { tag: null, parentId }
  editVisible.value = true
}

function openEdit(tag: Tag) {
  editing.value = { tag, parentId: tag.parent_id }
  editVisible.value = true
}

function openEditById(id: ShortId) {
  const tag = store.byId.get(id)
  if (tag) openEdit(tag)
}

// Locations too close together on the map to zoom apart: picked from a list,
// in the order the map gave them (by name).
const pickVisible = ref(false)
const pickIds = ref<ShortId[]>([])
const picked = computed(() =>
  pickIds.value.flatMap((id) => {
    const tag = store.byId.get(id)
    return tag && tag.deleted_at_utc === null ? [tag] : []
  }),
)

function openPick(ids: ShortId[]) {
  pickIds.value = ids
  const [first, ...more] = picked.value
  if (!first) return
  if (more.length === 0)
    openEdit(first) // the others are gone: nothing to pick from
  else pickVisible.value = true
}

function editPicked(tag: Tag) {
  pickVisible.value = false
  openEdit(tag)
}

// The merge dialog opens over the edit dialog; a merge closes both.
function openMerge(tag: Tag) {
  mergeSource.value = tag
  mergeVisible.value = true
}

function onMerged() {
  editVisible.value = false
}
</script>

<template>
  <Card>
    <template #title>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span>Tags</span>
        <Button
          v-if="tree.length > 0"
          :label="`Add ${noun}`"
          icon="pi pi-plus"
          size="small"
          @click="openAdd(null)"
        />
      </div>
    </template>

    <template #content>
      <Tabs :value="kind" scrollable @update:value="openTab">
        <TabList>
          <Tab v-for="k in KINDS" :key="k" :value="k">{{ TAB_LABELS[k] }}</Tab>
        </TabList>
      </Tabs>

      <div class="mt-4 flex flex-col gap-3">
        <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>

        <p v-else-if="!store.loaded" class="text-gray-500 dark:text-gray-400">Loading tags…</p>

        <div
          v-else-if="tree.length === 0"
          class="flex flex-col items-center gap-3 py-10 text-center"
        >
          <span
            :class="[setIconClass(KIND_ICONS[kind]), 'text-4xl text-gray-400']"
            aria-hidden="true"
          />
          <p class="max-w-sm text-gray-600 dark:text-gray-300">{{ KIND_HINTS[kind] }}</p>
          <Button :label="`Add your first ${noun}`" icon="pi pi-plus" @click="openAdd(null)" />
        </div>

        <template v-else>
          <!-- The dropdown takes a line of its own on a narrow screen. -->
          <div class="flex flex-wrap gap-2">
            <IconField class="min-w-0 flex-1">
              <InputIcon class="pi pi-search" />
              <InputText
                v-model="query"
                type="search"
                :placeholder="`Find a ${noun}`"
                :aria-label="`Find a ${noun} by any of its names`"
                fluid
              />
            </IconField>
            <Select
              v-if="linkSpec"
              v-model="linkChoice"
              input-id="tags-link-filter"
              :options="linkChoices"
              option-label="label"
              option-value="id"
              :aria-label="`Show only the ${nouns} of one ${linkSpec.noun}`"
              filter
              class="order-last w-full sm:order-none sm:w-56"
            >
              <template #value="{ value }">
                <TagOptionLabel :option="linkChoices.find((o) => o.id === value)" />
              </template>
              <template #option="{ option }">
                <TagOptionLabel :option="option" />
              </template>
            </Select>
            <SelectButton
              :model-value="display"
              :options="displays"
              option-value="value"
              option-label="label"
              :allow-empty="false"
              :aria-label="
                kind === 'location'
                  ? 'Show: slim rows, detailed rows or a map (kept on this device)'
                  : 'Rows: slim or detailed (kept on this device)'
              "
              @update:model-value="setDisplay"
            >
              <template #option="{ option }">
                <span :class="option.icon" aria-hidden="true" />
                <span class="sr-only sm:not-sr-only">{{ option.label }}</span>
              </template>
            </SelectButton>
          </div>

          <label v-if="archivedCount > 0" class="flex items-center gap-2 self-start text-sm">
            <ToggleSwitch v-model="showArchived" input-id="tags-show-archived" />
            Show archived {{ nouns }} ({{ archivedCount }})
          </label>

          <Message v-if="hasDuplicates" severity="warn" :closable="false">
            Some {{ nouns }} share a name with another one at the same level, usually because they
            were created on two devices. Merge them by hand: Edit → Merge into…
          </Message>

          <template v-if="onMap">
            <LocationsMap :locations="located.shown" @edit="openEditById" @pick="openPick" />
            <p v-if="located.unplaced > 0" class="text-sm text-gray-500 dark:text-gray-400">
              {{
                located.unplaced === 1
                  ? '1 location has no position, so it is not on the map.'
                  : `${located.unplaced} locations have no position, so they are not on the map.`
              }}
            </p>
            <p
              v-else-if="located.shown.length === 0 && filtering"
              class="text-gray-500 dark:text-gray-400"
            >
              {{ nothingMatches }}
            </p>
          </template>
          <ul v-else-if="rows.length > 0" class="flex flex-col" :aria-label="TAB_LABELS[kind]">
            <li v-for="row in rows" :key="row.tag.id">
              <TagTreeRow
                :row="row"
                :look="effectiveLook(row.tag, store.byId)"
                :other-names="otherNames(row.tag)"
                :link="linkOf(row.tag)"
                :facts="detailed ? factsOf(row.tag) : []"
                :detailed="detailed"
                :duplicate="store.duplicateIds.has(row.tag.id)"
                :noun="noun"
                @toggle="toggle(row.tag.id)"
                @add="openAdd(row.tag.id)"
                @edit="openEdit(row.tag)"
              />
            </li>
          </ul>
          <p v-else-if="filtering" class="text-gray-500 dark:text-gray-400">
            {{ nothingMatches }}
          </p>
          <p v-else class="text-gray-500 dark:text-gray-400">Every {{ noun }} is archived.</p>
        </template>

        <Message v-if="actionError" severity="error" :closable="false">{{ actionError }}</Message>

        <template v-if="store.loaded && deletedTags.length > 0">
          <label class="flex items-center gap-2 self-start text-sm">
            <ToggleSwitch v-model="showDeleted" input-id="tags-show-deleted" />
            Show deleted {{ nouns }} ({{ deletedTags.length }})
          </label>
          <ul v-if="showDeleted" class="flex flex-col" :aria-label="`Deleted ${nouns}`">
            <li v-for="tag in deletedTags" :key="tag.id" class="flex items-center gap-2 py-1">
              <span class="w-8 shrink-0" aria-hidden="true" />
              <IconBadge v-bind="effectiveLook(tag, store.byId)" small class="opacity-60" />
              <div class="flex min-w-0 flex-1 items-baseline gap-2">
                <span class="truncate text-gray-600 line-through dark:text-gray-300">
                  {{ tag.name }}
                </span>
                <span v-if="formerParent(tag)" class="truncate text-sm text-gray-500">
                  was under {{ formerParent(tag) }}
                </span>
              </div>
              <Button
                type="button"
                label="Restore"
                icon="pi pi-replay"
                severity="secondary"
                text
                size="small"
                :aria-label="`Restore ${tag.name}`"
                :pt="{ label: { class: 'hidden sm:inline' } }"
                @click="restore(tag)"
              />
            </li>
          </ul>
        </template>
      </div>
    </template>
  </Card>

  <Dialog
    v-model:visible="pickVisible"
    modal
    :header="`${picked.length} locations here`"
    :draggable="false"
    class="w-[32rem] max-w-[calc(100vw-2rem)]"
  >
    <ul class="flex flex-col" aria-label="Locations here">
      <li v-for="tag in picked" :key="tag.id">
        <Button
          type="button"
          severity="secondary"
          text
          class="w-full justify-start!"
          :aria-label="`Edit ${tag.name}`"
          @click="editPicked(tag)"
        >
          <IconBadge v-bind="effectiveLook(tag, store.byId)" small />
          <span class="min-w-0 truncate">{{ tag.name }}</span>
        </Button>
      </li>
    </ul>
  </Dialog>
  <TagEditDialog
    v-model:visible="editVisible"
    :kind="kind"
    :tag="editing.tag"
    :parent-id="editing.parentId"
    :close-on-escape="!mergeVisible"
    @merge="openMerge"
  />
  <TagMergeDialog
    v-if="mergeSource"
    v-model:visible="mergeVisible"
    :source="mergeSource"
    @merged="onMerged"
  />
</template>
