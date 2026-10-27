# Tags Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/tags` page where all five kinds of tags are created, renamed, moved, merged, deleted and restored, with their details, their other names and duplicates.

**Architecture:** The repository gains one all-or-nothing `save`, details on `create`, a `retired_names` column for removed merged names, and the merge fix. `useTagsStore` becomes write-through like `useAccountsStore`. Pure helpers (`src/tags/tree.ts`, `src/tags/otherNames.ts`, `look.ts`, `tagForm.ts`) carry the logic; `TagsView` + `TagEditDialog` + `TagMergeDialog` render it.

**Tech Stack:** Vue 3 `<script setup>` + TypeScript, PrimeVue 4 (Aura), Tailwind v4, Pinia, wa-sqlite, Vitest + Vue Test Utils.

**Spec:** [2026-10-27-tags-page-design.md](2026-10-27-tags-page-design.md) (with [category-vs-tag decisions](2026-10-26-category-vs-tag-decisions.md) §2.1, §2.3, §2.5–2.7).

## Global Constraints

- UI rules (CLAUDE.md): every action is a PrimeVue `Button` (`text` + `severity="secondary"` for low emphasis); icon buttons show their label from `sm` up (`:pt="{ label: { class: 'hidden sm:inline' } }"`) and carry an `aria-label` naming the target ("Edit Food"); derived values show fainter, name their source on hover/focus, and a typed value that replaced one offers a reset.
- Financial-data stores are write-through: persist, then re-read; a failed write rethrows and leaves the state unchanged.
- Names compare ignoring case with `toLocaleLowerCase()` (the repository's `foldCase`), after trimming.
- Path labels join names with ` › `; `TagLoopError` keeps its own ` > ` message.
- Migration `002` is edited in place; afterwards reset the local IndexedDB (and the test remote before a live sync).
- Run single test files with `npm run test:unit -- --run <path>`; the whole suite with `npm run test:unit -- --run`; also `npm run type-check` and `npm run lint` before each commit that touches `.ts`/`.vue`.
- Commits: conventional prefix with scope (`fix(tags):`, `feat(tags):`, `docs(tasks):`), imperative lowercase subject, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage paths explicitly (never `git add -A`: `.playwright-mcp/` is untracked).

## Review Focus

1. A parent loop that sync left (A under B, B under A) must not hang or hide the tree — both tags show (lifted to the top level). → Task 5 test `lifts tags caught in a parent loop to the top level`.
2. A tag whose parent is deleted or missing (sync race) shows at the top level, not nowhere. → Task 5 test `puts a tag whose parent is not live at the top level`.
3. Saving a tag whose existing name duplicates a sibling (sync-made duplicate) without renaming it must not be refused. → Task 2 test `does not re-check names the tag already had at its parent`.
4. Coordinates typed out of range (latitude 91) or only one of the two are refused before saving, with a message. → Task 6 test `validateDraft refuses a lone or out-of-range coordinate`.
5. A location still linked to a merchant deleted since can be saved unchanged and keeps the link. → Task 2 test `keeps a link to a tag deleted since`.

---

### Task 1: A merge fills empty details with the source's links to deleted tags

**Files:**
- Modify: `src/db/repositories/TagDetailsRepository.ts` (`assertDetailLinks`)
- Modify: `src/db/repositories/TagsRepository.ts` (`merge`)
- Test: `src/db/repositories/__tests__/TagsRepository.spec.ts`

**Interfaces:**
- Produces: `assertDetailLinks(ex: SqlExecutor, kind: TagKind, values: DetailLinks, ...known: (DetailLinks | null)[]): Promise<void>` — a link equal to the same field in any `known` set is not checked. `TagDetailsRepository.write` passes the stored values as before; `merge` passes `into` and `from`.

- [ ] **Step 1: Write the failing tests** in the `merge` describe block:
  - `fills the target's empty merchant with the source's link to a merchant deleted since` — location S with merchant M, location T without one, `softDelete(M)`; `merge(S, T)` resolves; `getLocation(T).merchant_id === M`.
  - `fills an empty default category with the source's deleted one` — the same for two merchants and a deleted category.
  - `still refuses a resolved link on neither side that is deleted` — S and T with different live merchants, a third merchant D deleted; `merge(S, T, { merchant_id: D })` rejects with `DeletedTagError`, and S is still live.
  - `accepts a resolved link equal to the source's deleted one` — S → deleted M, T → live N; `merge(S, T, { merchant_id: M })` resolves.
- [ ] **Step 2: Run** `npm run test:unit -- --run src/db/repositories/__tests__/TagsRepository.spec.ts` — the first, second and fourth fail with `DeletedTagError`.
- [ ] **Step 3: Implement** the `...known` parameter; in `merge` call `assertDetailLinks(tx, target.kind, next, into, from)`. Update the comment above that call.
- [ ] **Step 4: Run** the file again — PASS.
- [ ] **Step 5: Commit** `fix(tags): let a merge fill empty details with the source's deleted links`.

---

### Task 2: One all-or-nothing save; create with details

**Files:**
- Modify: `src/db/repositories/TagsRepository.ts`
- Test: `src/db/repositories/__tests__/TagsRepository.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TagSaveInput = {
    name: string
    parent_id: ShortId | null
    description: string | null
    otherNames: string[] // the synonyms the user keeps or adds (Task 3 adds merged names)
    colour: string | null // null = inherited
    icon: string | null // null = inherited
    details: TagDetailValues // fields of other kinds are ignored
  }
  TagsRepository.save(id: ShortId, input: TagSaveInput): Promise<void>
  TagCreateInput.details?: TagDetailValues // written in the create's transaction
  ```
- `save` runs in one `db.transaction`: live check, then (if `parent_id` changed) parent kind check, loop check (`TagLoopError`), then the names check at the parent the tag ends up under — all its names when the parent changes, only the added ones when it does not — then the writes. Columns are written only if one changed (no `updated_at_utc` bump on an unchanged save); `moved_at_utc` only when the parent changed; details only when a field of the kind changed (`sameDetail`), with `assertDetailLinks(tx, kind, next, stored)` and `assertJourneyDates` when a date changed. In this task `otherNames` (trimmed, empty and duplicate-ignoring-case dropped, the main name dropped) is the new `synonyms`.

- [ ] **Step 1: Write the failing tests** (`describe('save')`):
  - `renames, moves and writes details in one go` — location "Shop" under Berlin saved as "Rewe" under Munich with address "Main St 1" and a position: all three visible afterwards, `moved_at_utc` changed.
  - `changes nothing when the name is taken at the new parent` — "Rewe" exists under Munich; saving "Shop" (under Berlin) as "Rewe" under Munich rejects with `DuplicateTagNameError`; the tag is still "Shop" under Berlin with its old details.
  - `refuses a move under its own descendant and changes nothing` — Food > Groceries; saving Food with parent Groceries and a new description rejects with `TagLoopError` whose `path` is `['Food', 'Groceries']`; the description is unchanged.
  - `does not bump updated_at_utc when nothing changed` — save with the tag's own values; `updated_at_utc` and `moved_at_utc` equal before and after.
  - `does not re-check names the tag already had at its parent` — insert two live sibling tags both named "Rewe" (raw insert, as sync would); saving one with a new description resolves.
  - `keeps a link to a tag deleted since` — location linked to merchant M, `softDelete(M)`; save with `merchant_id: M` and a new address resolves; the link stays.
  - `refuses a new link to a deleted tag` — rejects with `DeletedTagError`.
  - `refuses journey dates that end before they start` — `InvalidTagDetailsError`.
  - `create writes the details in the same transaction` — `create({ kind: 'merchant', name: 'Rewe', details: { …default_category_id: groceries } })`; `getMerchant` returns it. And `create` with a deleted category rejects and leaves no tag named "Rewe".
- [ ] **Step 2: Run** the file — the new tests fail (`save` is not a function).
- [ ] **Step 3: Implement** `TagSaveInput`, `save`, and `details` on `create` (reuse `readDetailValues`, `writeDetailValues`, `assertDetailLinks`, `assertJourneyDates`, `assertParent`, `loopPath`, `assertNamesFree`).
- [ ] **Step 4: Run** the file — PASS. Run `npm run type-check`.
- [ ] **Step 5: Commit** `feat(tags): save a tag's fields, parent and details in one transaction`.

---

### Task 3: `retired_names` — removing a merged name stops it finding the tag

**Files:**
- Modify: `src/db/migrations/002_domain_schema.ts` (column after `synonyms`), `src/db/types.ts` (`Tag.retired_names: string[] // names that no longer find this tag through a tag merged into it`), `src/db/repositories/TagsRepository.ts` (`TagRow`, `rowToTag`, `findByName`, `merge`, `update`, `save`), `src/sync/syncColumns.ts` (tags descriptor)
- Modify: every test fixture that builds a `Tag` literal (find them with `npm run type-check`)
- Create: `src/tags/otherNames.ts`
- Test: `src/tags/__tests__/otherNames.spec.ts`, `src/db/repositories/__tests__/TagsRepository.spec.ts`, `src/sync/__tests__/cornerCases/merges.spec.ts`

**Interfaces:**
- Produces (`src/tags/otherNames.ts`):
  ```ts
  /** Names and synonyms of the merged tags whose merge chain ends at `id` (case-insensitively unique, first spelling, in `tags` order). */
  export function carriedNames(id: ShortId, tags: readonly Tag[]): string[]
  /** The names shown as merged on `tag`: carried names minus its name, synonyms and retired names. */
  export function mergedNames(tag: Tag, tags: readonly Tag[]): string[]
  /** What the tag stores when the user keeps `kept` as its other names. */
  export function applyOtherNames(
    tag: Pick<Tag, 'name' | 'synonyms' | 'retired_names'>,
    carried: readonly string[],
    kept: readonly string[],
  ): { synonyms: string[]; retired_names: string[] }
  ```
  `applyOtherNames`: `kept` is trimmed, empties, the main name and case-insensitive duplicates dropped. `synonyms` = kept names except those that are merged-only (carried, not a current synonym). `retired_names` = (current retired ∪ removed names that are carried) − kept, where removed = (synonyms ∪ merged-only) − kept.
- `save` uses `applyOtherNames` with the carried names of the tag (read in the transaction); the names check covers only the new `synonyms`.
- `findByName`: a merged match is skipped when the folded name is in `retired_names` of any tag on its chain, the matched tag and the end included.
- `merge`: the target's `retired_names` becomes (target's ∪ source's) − the target's names after the merge.
- `update` with `synonyms`: those names leave `retired_names`.

- [ ] **Step 1: Write the failing tests** (`otherNames.spec.ts`):
  - `carriedNames follows chains that end at the tag` — X (merged into Y, synonyms ['occupation']) and W (merged into X): carried for Y = ['job', 'occupation', 'side job'] in that order; nothing for an unrelated tag; a cycle does not hang.
  - `mergedNames leaves out the tag's own names and retired ones`.
  - `applyOtherNames retires a removed merged name` — carried ['job'], synonyms ['job'], kept [] → `{ synonyms: [], retired_names: ['job'] }`.
  - `applyOtherNames drops a plain synonym without retiring it` — carried [], synonyms ['WB'], kept [] → retired [].
  - `applyOtherNames keeps a merged-only name out of the synonyms` — carried ['job'], synonyms [], kept ['job'] → synonyms [].
  - `applyOtherNames un-retires a name typed again` — retired ['job'], kept ['Job'] → synonyms ['Job'], retired [].
- [ ] **Step 2: Write the failing repository tests:**
  - `a removed merged name no longer finds the tag` — merge "job" into "work"; `save(work, { …otherNames: [] })`; `findByName('tag', 'job')` is null; `findByName('tag', 'work')` still finds it.
  - `a retired name stays retired after a further merge` — then merge "work" into "employment"; `findByName('tag', 'job')` is null.
  - `retired_names round-trips and defaults to []`.
- [ ] **Step 3: Write the failing sync test** in `merges.spec.ts`: `a removed merged name stops finding the tag on the other device too` — after a merge on A and a sync of both, A saves the target without the name, both sync (`settle`), `expectSound`, and `findByName` is null on both.
- [ ] **Step 4: Run** the three files — FAIL.
- [ ] **Step 5: Implement** the column (`retired_names TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(retired_names)), -- JSON array of names that no longer find this tag through a tag merged into it`), types, mappers, `SYNC_COLUMNS`, `otherNames.ts`, and the repository changes. Fix the fixtures `type-check` reports.
- [ ] **Step 6: Run** `npm run test:unit -- --run` (whole suite: the schema change touches sync tests) and `npm run type-check` — PASS.
- [ ] **Step 7: Commit** `feat(tags): retire removed merged names so they stop finding the tag`.

---

### Task 4: Write-through tags store; nested plain tags on accounts

**Files:**
- Modify: `src/db/repositories/TagDetailsRepository.ts` (`values` — already added with Task 3), `src/stores/tags.ts`, `src/components/accounts/AccountEditDialog.vue` (passes the account's ids)
- Test: `src/stores/__tests__/tags.spec.ts`

Design §6a: `resolvePlainTags(names: readonly string[], known: readonly ShortId[] = []): Promise<ShortId[]>` — a name that is the current name or a synonym (ignoring case) of a live plain tag in `known` resolves to it; otherwise `findByName('tag', name)` at any level; otherwise a new top-level tag. Tests: `keeps a nested tag the account already has`, `finds a nested tag by a typed name`, `prefers the account's own tag over an older namesake elsewhere`; rename `does not match tags of another kind or below a parent` to `does not match tags of another kind`.

**Interfaces:**
- Produces:
  ```ts
  TagDetailsRepository.values(id: ShortId, kind: TagKind): Promise<TagDetailValues>
  useTagsStore(): {
    tags, byId, loaded: Ref<boolean>, duplicateIds: Ref<ReadonlySet<ShortId>>,
    load(), nameOf(id), resolvePlainTags(names), // existing
    create(input: TagCreateInput): Promise<Tag>,
    save(id: ShortId, input: TagSaveInput): Promise<void>,
    merge(sourceId: ShortId, targetId: ShortId, resolved?: Partial<TagDetailValues>): Promise<void>,
    remove(id: ShortId): Promise<void>,   // softDelete
    restore(id: ShortId): Promise<void>,
    usageCount(id: ShortId): Promise<number>,
    detailConflicts(sourceId: ShortId, targetId: ShortId): Promise<TagDetailConflict[]>,
    details(tag: Tag): Promise<TagDetailValues>,
    journeyDates(id: ShortId): ReturnType<TagDetailsRepository['journeyDates']>,
  }
  ```
  `load()` reads `listAll()` and `duplicates()` together and sets `loaded`. Every write persists and then `load()`s; a failure rethrows before the reload.

- [ ] **Step 1: Write the failing tests:** `create persists and reloads`, `save reloads the renamed tag`, `merge reloads both tags`, `remove and restore`, `load collects duplicate ids`, `a failed save rethrows and leaves the tags as they were` (duplicate name).
- [ ] **Step 2: Run** `npm run test:unit -- --run src/stores/__tests__/tags.spec.ts` — FAIL.
- [ ] **Step 3: Implement** (mock `@/db/init` with `getTagDetailsRepository` added, as the existing spec does for the tags repository).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(tags): write-through tag actions in the tags store`.

---

### Task 5: Tree, paths, options and inherited look

**Files:**
- Create: `src/tags/tree.ts`; Modify: `src/tags/look.ts`
- Test: `src/tags/__tests__/tree.spec.ts`, `src/tags/__tests__/look.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TagNode { tag: Tag; children: TagNode[] }
  export function buildTree(tags: readonly Tag[], kind: TagKind): TagNode[]
  export function filterTree(nodes: readonly TagNode[], matches: (tag: Tag) => boolean): TagNode[]
  export function tagMatches(tag: Tag, query: string, merged: readonly string[]): boolean
  export function tagPath(tag: Tag, byId: ReadonlyMap<ShortId, Tag>): string[]
  export function pathLabel(path: readonly string[]): string // ' › '
  export function subtreeIds(id: ShortId, tags: readonly Tag[]): Set<ShortId> // id + live descendants
  export function tagOptions(tags: readonly Tag[], kind: TagKind, exclude?: ReadonlySet<ShortId>): { id: ShortId; label: string }[]
  // look.ts
  export interface InheritedLook extends TagLook { colourFrom: Tag | null; iconFrom: Tag | null } // null = the default
  export function inheritedLook(kind: TagKind, parentId: ShortId | null, selfId: ShortId | null, byId: ReadonlyMap<ShortId, Tag>): InheritedLook
  ```
  `buildTree`: live tags of `kind`; siblings by name (`localeCompare` with `sensitivity: 'base'`), then id. `filterTree` keeps matches and their ancestors (non-matching descendants are dropped). `tagMatches`: empty query matches all; else case-insensitive substring of the name, a synonym or a merged name. `tagOptions`: live tags of `kind` not in `exclude`, labelled `pathLabel(tagPath(…))`, sorted by label. `inheritedLook`: what a tag that sets neither colour nor icon shows under `parentId` — the parent's `effectiveLook` with the tags it came from; at the top level the kind's icon and the preset chosen by `selfId` (as `effectiveLook` does), both `from` null.

- [ ] **Step 1: Write the failing tests:** `nests children under their parents, sorted by name`, `puts a tag whose parent is not live at the top level`, `lifts tags caught in a parent loop to the top level` (A.parent = B, B.parent = A, both appear once), `leaves out deleted tags and other kinds`, `filterTree keeps ancestors of a match`, `tagMatches finds a synonym or merged name ignoring case`, `tagPath stops on a loop`, `subtreeIds covers descendants`, `tagOptions excludes a subtree and labels by path` (label `'Food › Groceries'`), `inheritedLook names the ancestor the colour comes from`, `inheritedLook at the top level is the default`.
- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(tags): tree, path and inherited-look helpers for the tags page`.

---

### Task 6: The edit dialog

**Files:**
- Create: `src/components/tags/tagForm.ts`, `src/components/tags/TagEditDialog.vue`, `src/components/derived.ts`
- Test: `src/components/tags/__tests__/tagForm.spec.ts`, `src/components/tags/__tests__/TagEditDialog.spec.ts`

**Interfaces:**
- Consumes: Task 4 store, Task 5 helpers, Task 3 `mergedNames`, `newTagLook`, `ColourPicker`, `IconPicker`, `AccountBadge` (a generic icon + colour badge).
- Produces:
  ```ts
  // tagForm.ts
  export interface TagDraft {
    name: string; parent_id: ShortId | null; otherNames: string[]; description: string
    colour: string | null; icon: string | null // null = inherited
    address: string; latitude: number | null; longitude: number | null
    merchant_id: ShortId | null; default_category_id: ShortId | null
    start_date: string | null; end_date: string | null // null = derived
  }
  export interface TagDraftErrors { name?: string; position?: string; dates?: string }
  export function newTagDraft(kind: TagKind, parentId: ShortId | null): TagDraft // top level: newTagLook; child: null/null
  export function draftFromTag(tag: Tag, details: TagDetailValues, merged: readonly string[]): TagDraft
  export function validateDraft(draft: TagDraft): TagDraftErrors
  export function saveInputFromDraft(draft: TagDraft): TagSaveInput
  // derived.ts
  export const DERIVED_TEXT: string // the one class for derived values, reused by the transaction form
  // TagEditDialog.vue
  props: { kind: TagKind; tag: Tag | null; parentId?: ShortId | null }
  v-model:visible; emits: merge(tag: Tag)
  ```
  `validateDraft` messages: name — "Give the tag a name."; position — "Enter both coordinates or neither." / "Latitude goes from −90 to 90, longitude from −180 to 180."; dates — "The journey cannot end before it starts." (only when both dates are typed). Name at most 60 characters (`maxlength`). Dialog behaviour, copy and per-kind fields are in design §3 and §6 (delete confirmation, category in use → "Merge into…" emitting `merge`).

- [ ] **Step 1: Write the failing `tagForm.spec.ts` tests:** `newTagDraft gives a top-level tag a preset colour and its kind's icon`, `newTagDraft lets a child inherit`, `draftFromTag lists synonyms then merged names`, `validateDraft refuses a missing name`, `validateDraft refuses a lone or out-of-range coordinate`, `validateDraft refuses an end before the start`, `saveInputFromDraft trims and maps empty text to null`.
- [ ] **Step 2: Write the failing `TagEditDialog.spec.ts` tests** (real store over an in-memory database, as `AccountsView.spec.ts`): `creates a top-level category`, `renames and moves in one save`, `shows the inherited colour as derived and resets an own one`, `edits a location's address, position and merchant`, `fills the position from the device` (stubbed `navigator.geolocation`; a refusal shows its error), `shows a journey's derived dates and resets a typed one`, `removes a merged name`, `shows the repository's refusal and keeps the dialog open` (duplicate name), `deletes after confirming with the use count`, `offers a merge instead of deleting a category in use`.
- [ ] **Step 3: Run** both files — FAIL.
- [ ] **Step 4: Implement** `tagForm.ts`, `derived.ts` and the dialog (Selects with `filter` for parent / merchant / default category from `tagOptions`; `AutoComplete multiple :typeahead="false"` for other names, merged-only ones marked; `DatePicker` for dates; "Use my position" via `navigator.geolocation.getCurrentPosition`; a deleted linked tag shown as "<name> (deleted)").
- [ ] **Step 5: Run** both files, `npm run type-check`, `npm run lint` — PASS.
- [ ] **Step 6: Commit** `feat(tags): tag edit dialog with details, other names and delete`.

---

### Task 7: The merge dialog

**Files:**
- Create: `src/components/tags/TagMergeDialog.vue`
- Test: `src/components/tags/__tests__/TagMergeDialog.spec.ts`

**Interfaces:**
- Consumes: store `merge`, `usageCount`, `detailConflicts`; `tagOptions`, `subtreeIds`.
- Produces: `props: { source: Tag }`, `v-model:visible`, emits `merged()`.
  Copy and behaviour: design §5. Each conflict offers the source's value, the target's value, or another one (address text, both coordinates, a merchant / category Select, a date); "Merge" is disabled until a target is picked and every conflict answered. `TagLoopError` shows its message; `MergeConflictError` re-reads the conflicts.

- [ ] **Step 1: Write the failing tests:** `lists targets of the same kind without the source's subtree`, `warns with the use count before merging`, `merges and emits merged`, `asks for each conflicting detail and passes the answers` (two locations with different addresses; choose "another" and type one; the target gets it), `keeps Merge disabled until every conflict is answered`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, `npm run type-check`, `npm run lint` — PASS.
- [ ] **Step 5: Commit** `feat(tags): merge dialog with detail conflicts`.

---

### Task 8: The Tags page

**Files:**
- Create: `src/views/TagsView.vue`, `src/components/tags/TagTreeRows.vue`
- Modify: `src/router/index.ts` (`/tags`, name `tags`, lazy), `src/stores/layout.ts` (`{ label: 'Tags', icon: 'pi pi-tags', route: '/tags' }` after Accounts) and any nav test that lists the items
- Test: `src/views/__tests__/TagsView.spec.ts`

**Interfaces:**
- Consumes: everything above. The open kind is `route.query.kind` (one of the five, else `category`); switching tabs `router.replace`s the query.
- Produces: the page as in design §2 (tabs, header add button, filter, tree rows with Add / Edit, duplicate chip + note, "Show deleted" with Restore, empty state, load error). Edit opens `TagEditDialog`; its `merge` event opens `TagMergeDialog`; a merge closes both.

- [ ] **Step 1: Write the failing tests:** `opens the tab named in the query`, `shows the tree nested and sorted`, `collapses and expands a branch`, `filters to matches and their ancestors`, `marks duplicates and explains them`, `lists deleted tags and restores one`, `shows an empty state per kind`, `adds a child from a row`, `merges from the edit dialog and updates the tree`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the page, rows, route and nav item.
- [ ] **Step 4: Run** the whole suite, `npm run type-check`, `npm run lint` — PASS.
- [ ] **Step 5: Commit** `feat(tags): tags page with a tree per kind`.

---

### Task 9: Docs and the browser check

**Files:**
- Modify: `TASKS.md`, `CLAUDE.md` (Tags bullet: `retired_names`), `docs/plans/2026-10-26-category-vs-tag-decisions.md` §2.5 (what counts as a use: nothing until import rules; "making X a synonym of Y" is done with "Merge into…", a taken name is refused), `docs/plans/2026-10-27-tags-page-design.md` (an "As built" note for anything that changed)

- [ ] **Step 1:** In the browser (Playwright MCP, `npm run dev`): delete the `moneytracker` IndexedDB first (migration edited), then at 390 px and 1280 px, light and dark: create a category tree, a merchant with a default category, a location with "Use my position", a journey; rename + move; merge two locations with a conflict; delete and restore; filter. Screenshots go to `.playwright-mcp/`.
- [ ] **Step 2:** `TASKS.md`: move the Tags page (incl. the merge fix and retired names) to Done; drop the "Before merge ships" item; fix the stale entries (Pinia section lists tags and locations; the Domain schema section's `locations` table and natural-key tags; the exchange-rates list numbering).
- [ ] **Step 3:** Final `npm run test:unit -- --run`, `npm run type-check`, `npm run lint`, `npm run build-only`.
- [ ] **Step 4: Commit** `docs: tags page built; decisions and tasks updated`.
