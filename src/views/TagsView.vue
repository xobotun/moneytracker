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
import Button from 'primevue/button'
import Message from 'primevue/message'
import AccountBadge from '@/components/accounts/AccountBadge.vue'
import TagTreeRow from '@/components/tags/TagTreeRow.vue'
import TagEditDialog from '@/components/tags/TagEditDialog.vue'
import TagMergeDialog from '@/components/tags/TagMergeDialog.vue'
import { KIND_NOUNS } from '@/components/tags/tagForm'
import { useTagsStore } from '@/stores/tags'
import type { ShortId } from '@/db/shortId'
import type { Tag, TagKind } from '@/db/types'
import { KIND_ICONS, effectiveLook } from '@/tags/look'
import { mergedNamesByTag } from '@/tags/otherNames'
import {
  buildTree,
  filterTree,
  flattenTree,
  pathLabel,
  tagMatches,
  tagPath,
  type RowLink,
} from '@/tags/tree'

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

// --- The tree ---

const query = ref('')
const collapsed = ref(new Set<ShortId>())
watch(kind, () => {
  query.value = ''
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
const tree = computed(() => buildTree(store.tags, kind.value))
const filtering = computed(() => query.value.trim() !== '')
const shownTree = computed(() =>
  filtering.value
    ? filterTree(tree.value, (t) => tagMatches(t, query.value, merged.value.get(t.id) ?? []))
    : tree.value,
)
// While filtering every branch is open, so each match shows.
const rows = computed(() =>
  flattenTree(shownTree.value, (id) => filtering.value || !collapsed.value.has(id)),
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
          <span :class="`pi pi-${KIND_ICONS[kind]} text-4xl text-gray-400`" aria-hidden="true" />
          <p class="max-w-sm text-gray-600 dark:text-gray-300">{{ KIND_HINTS[kind] }}</p>
          <Button :label="`Add your first ${noun}`" icon="pi pi-plus" @click="openAdd(null)" />
        </div>

        <template v-else>
          <IconField>
            <InputIcon class="pi pi-search" />
            <InputText
              v-model="query"
              type="search"
              :placeholder="`Find a ${noun}`"
              :aria-label="`Find a ${noun} by any of its names`"
              fluid
            />
          </IconField>

          <Message v-if="hasDuplicates" severity="warn" :closable="false">
            Some {{ noun }}s share a name with another one at the same level, usually because they
            were created on two devices. Merge them by hand: Edit → Merge into…
          </Message>

          <ul v-if="rows.length > 0" class="flex flex-col" :aria-label="TAB_LABELS[kind]">
            <li v-for="row in rows" :key="row.tag.id">
              <TagTreeRow
                :row="row"
                :look="effectiveLook(row.tag, store.byId)"
                :other-names="otherNames(row.tag)"
                :link="linkOf(row.tag)"
                :duplicate="store.duplicateIds.has(row.tag.id)"
                :noun="noun"
                @toggle="toggle(row.tag.id)"
                @add="openAdd(row.tag.id)"
                @edit="openEdit(row.tag)"
              />
            </li>
          </ul>
          <p v-else class="text-gray-500 dark:text-gray-400">Nothing matches “{{ query }}”.</p>
        </template>

        <Message v-if="actionError" severity="error" :closable="false">{{ actionError }}</Message>

        <template v-if="store.loaded && deletedTags.length > 0">
          <label class="flex items-center gap-2 self-start text-sm">
            <ToggleSwitch v-model="showDeleted" input-id="tags-show-deleted" />
            Show deleted {{ noun }}s ({{ deletedTags.length }})
          </label>
          <ul v-if="showDeleted" class="flex flex-col" :aria-label="`Deleted ${noun}s`">
            <li v-for="tag in deletedTags" :key="tag.id" class="flex items-center gap-2 py-1">
              <span class="w-8 shrink-0" aria-hidden="true" />
              <AccountBadge v-bind="effectiveLook(tag, store.byId)" small class="opacity-60" />
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
