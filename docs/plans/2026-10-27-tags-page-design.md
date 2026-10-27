# Tags Page: Design

**Status:** Decided 2026-10-27. Pavel handed over the details; the calls marked *(my call)* are open to veto.
**Builds on:** [category-vs-tag decisions](2026-10-26-category-vs-tag-decisions.md) (§2.1 tags, §2.3 typed and derived values, §2.5 synonyms, merging and deleting, §2.6–2.7 details), the tags data layer from [tags-and-categories plan](2026-10-26-tags-and-categories-plan.md) part B.

---

## 1. Intent

The tags data layer is built, but nothing in the app shows or edits tags apart from the free-form plain tags on accounts. The transaction form needs categories, merchants, locations and journeys to pick from, and someone has to keep them tidy: rename, nest, merge the duplicates two phones created offline, fill in a store's address. The Tags page is that place.

**Success:** both users can build and tidy all five kinds of tags on a phone or a PC without knowing how they are stored, and nothing they do there can lose a transaction's reference or leave a tag half-saved.

**Non-goals:** the transaction form and its pickers; reports; import rules; drag-and-drop moving (the parent picker moves a tag); the "on a journey" switch; per-row usage counts; a map.

**Anti-goals:** a merge that happens without the user asking (§2.5); a delete that silently drops a category from transactions; a save that applies the rename but not the move.

---

## 2. The page

- **Route and nav** *(my call)*: `/tags`, nav item "Tags" (`pi pi-tags`) after Accounts. A tab per kind, in this order: Categories, Merchants, Locations, Journeys, Tags. The open tab is the `kind` query parameter (`/tags?kind=merchant`, default `category`), so a link or reload keeps it.
- **Header:** the page title and an "Add category" / "Add merchant" / … button for the open tab (a new top-level tag).
- **Filter** *(my call)*: a text box above the tree. It matches a tag's name, synonyms and merged names (§4), ignoring case, anywhere in the text. Matching tags show with their ancestors, all expanded; the rest are hidden.
- **Tree** *(my call)*: custom rows like the Accounts page, not PrimeVue `Tree`: `Tree` brings its own arrow-key selection model, which fights the per-row Buttons the UI rules ask for. Children are indented under their parent with an expand/collapse Button (disclosure pattern, `aria-expanded`). Everything starts expanded; collapsing lasts until the page is left. Siblings sort by name (case-insensitive, `localeCompare`).
- **A row:** the tag's badge (its effective colour and icon, `effectiveLook`), the name, then its other names in fainter, smaller text, cut off with an ellipsis on narrow screens. Two Buttons: "Add" (`pi pi-plus`, a child of this tag; `aria-label` "Add a category under Food") and "Edit" (`pi pi-pencil`, `aria-label` "Edit Food"), labels shown from `sm` up.
- **Duplicates** (§2.5): `TagsRepository.duplicates()` groups. A row in a group gets a warning chip "Duplicate" and a warning outline. When the open tab has any, a note above the tree: "Some tags share a name with another one at the same level, usually because they were created on two devices. Merge them by hand: Edit → Merge into…". The app never offers or performs the merge itself.
- **Deleted tags** *(my call)*: a "Show deleted" toggle per tab lists the deleted, unmerged tags of that kind below the tree, flat, each with its name, the parent it had ("was under Food", when that parent still exists) and a Restore Button. Merged tags are never listed: they cannot come back, and their names show on the tag they were merged into.
- **Empty tab:** an icon, a sentence on what this kind is for (one line each, from §1 of the decisions), and an "Add your first …" Button.
- **Errors** loading the page show as a Message, like the Accounts page.

---

## 3. The edit dialog

One dialog creates and edits a tag of any kind ("New category", "Edit category"). Fields:

- **Name** (required, trimmed, at most 60 characters *(my call, same as accounts)*).
- **Parent**: a filterable Select of the live tags of the same kind, each labelled by its path ("Food › Groceries"), plus "None (top level)". The tag itself and its descendants are left out, so the picker cannot make a loop; a loop that a sync brought in meanwhile still comes back from the repository as `TagLoopError`, shown with its path ("Food > Groceries > Food").
- **Other names**: one chip list (type and press Enter or comma to add; a chip's × removes it). It shows the tag's synonyms and its merged names (§4); a merged name that is not also a synonym is marked as merged ("from merging Lunch"), hover or focus says so. Rules in §4. Typing the name of another tag at the same level is refused like any taken name (`DuplicateTagNameError`), with a hint to use "Merge into…" on that tag *(my call)*: §2.5's "making X a synonym of Y merges X into Y" is that merge, reached through its own dialog, so a merge never happens as a side effect of a save with other unsaved edits.
- **Description** (optional, multi-line).
- **Colour and icon** — derived values under §2.3. A tag that sets neither shows its parent's (or the default: the kind's icon, a colour picked by the top tag's id) in fainter text, with "from Food" (or "default") on hover or focus. Picking a colour or icon makes it the tag's own; a small reset Button next to an own value brings inheritance back (stores NULL). A new top-level tag starts with its own random preset colour and its kind's icon (`newTagLook`, §2.1); a new child starts inheriting both. The badge at the top of the dialog previews the effective look. Reuse `ColourPicker` and `IconPicker`.
- **Per kind:**
  - **Location:** address (free text); coordinates as two number inputs (latitude, longitude; both or neither) with a "Use my position" Button (`navigator.geolocation`, its error shown inline; the filled coordinates are typed values, the user asked for them); merchant (a filterable Select of live merchants by path, or none).
  - **Merchant:** default category (a filterable Select of live categories by path, or none).
  - **Journey:** start and end date (date pickers). Each date is derived from the journey's transactions and the journeys under it (`TagDetailsRepository.journeyDates`) until typed: a derived date shows fainter, with "from its transactions" on hover; a typed one has the reset Button, which goes back to derived. With nothing to derive from, the field is empty.
  - A link the tag already has to a tag deleted since (a location's merchant, a merchant's default category) stays selectable, shown as "Rewe (deleted)", so saving does not drop it; nothing new can be linked to a deleted tag.
- **Footer:** Save, Cancel; when editing also "Merge into…" and Delete (the Accounts dialog's layout and inline delete confirmation).
- **Validation** shows after the first save attempt, like the account dialog: a missing name, a lone coordinate, an end before the start. Repository refusals (a name taken at that level — `DuplicateTagNameError` names it; a loop) show as the dialog's error Message, and nothing is saved.

**One save, one database transaction.** Today renaming, moving and writing details are three repository calls, each its own transaction, and a move re-checks the names at the new parent. Chained, they can leave a tag moved but not renamed. The dialog therefore saves through one new repository call that applies the tag's fields, its parent and its details in a single `db.transaction`, checking the names at the parent the tag ends up under. Creating takes the details too. The existing `update`, `move` and `TagDetailsRepository.set*` stay for other callers.

---

## 4. Merged names and `retired_names`

§2.5: a tag's merged names are its synonyms and the names of the tags merged into it, also through a chain of merges; a merged name can be removed only while nothing uses it, and removing it stops it finding the tag.

**Why a new column.** A merge already copies the source's name and synonyms into the target's `synonyms`, but `findByName` also matches the merged tag's own row and follows its merge chain (that keeps names findable along a chain merged on two devices, where sync never copies them). So dropping a name from the synonyms is not enough. Writing to the merged tag's row would not sync: a tombstone hashes as its id and delete time only (`rowHash`). The removal is therefore stored on the live tag.

- **Schema:** `tags.retired_names TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(retired_names))` — a JSON array of names that no longer find this tag through a merged tag. Migration `002` is edited in place (no real data yet; reset local IndexedDB and the test remote afterwards). Synced like any column: `SYNC_COLUMNS`, `Tag.retired_names: string[]`, `rowToTag`.
- **A tag's merged names** = the names and synonyms of the merged tags whose merge chain ends at it, minus its own name, its synonyms and its `retired_names` (compared ignoring case, as all names are).
- **Removing a name** from the dialog's chip list drops it from `synonyms` if it is there, and adds it to `retired_names` if a merged tag in the chain carries it. Adding a name puts it in `synonyms` and takes it out of `retired_names`. A name is never both a synonym and retired.
- **Lookup:** `findByName`'s fallback skips a merged match when any tag on its chain, the end included, lists the name in `retired_names`. Live names win before the fallback, as today.
- **Merging** a tag that has retired names into another one carries them to the target, except those the target then has as a name or synonym.
- **What counts as a use** *(my call; the decisions doc left it to this page)*: nothing yet. Transactions reference tags by id, never by name; the import rules that would match a name do not exist. So every name can be removed for now; when import rules land, a rule matching the name blocks its removal. Update §2.5 of the decisions doc to say so.

---

## 5. Merging

"Merge into…" in the edit dialog opens a merge dialog for the tag being edited (the source):

- **Target:** a filterable Select of the live tags of the same kind by path, leaving out the source and its descendants (the repository refuses those with `TagLoopError`; the path is shown if a race gets one through).
- **Warning**, before anything is changed: "Lunch will be deleted. Its N uses move to Food › Everyday (parts of one transaction in both are added together), its sub-tags move under it, and its names become other names of it. Food › Everyday keeps its colour, icon and description." N is `usageCount`.
- **Detail conflicts** (locations, merchants, journeys): once a target is chosen, `detailConflicts(source, target)` lists the fields where both have different values. For each: keep the source's value, keep the target's, or type another (an address text, coordinates, a merchant or category picked from the same Select as in the edit dialog, a date). Merge is enabled when every conflict has an answer; the answers go in `resolved`. A `MergeConflictError` (a sync changed the details meanwhile) re-reads the conflicts.
- After the merge both dialogs close and the tree reloads.
- **Fix first** (TASKS.md "Before merge ships"): `merge` refuses to fill the target's empty detail with the source's link to a tag deleted since (`DeletedTagError`), and `detailConflicts` does not mention it. §2.5 says the source's details fill the ones the target lacks, so the liveness check is skipped for a value either tag already has, and kept only for a `resolved` value that is on neither side.

---

## 6. Deleting and restoring

- Delete asks for confirmation inline in the dialog with the use count: "Used by N transactions and accounts. They keep it, hidden, and get it back if you restore it. Its sub-tags move up one level." (`usageCount`; zero uses: no count sentence.)
- A category in use cannot be deleted (`CategoryInUseError`): instead of the confirmation, the dialog says "Every transaction needs a category, so a category in use can only be merged into another one" with a "Merge into…" Button.
- Restore (in the deleted list) returns the tag under its old parent when that parent is live, else at the top level (the repository does this).

---

## 6a. Nested plain tags on accounts

Plain tags get a tree like every kind (§2.1: any kind can have a parent). Until now none could be nested, and the account dialog relies on that: on save it turns each chip back into an id with `resolvePlainTags`, which looks only at top-level tags, and keeps a stored id only if that lookup returns it. Once #mia sits under #family, saving any account with #mia would create a new top-level #mia and swap the account over to it — a lost reference, against §1.

*(my call)* `resolvePlainTags` takes the ids the account already has: a chip whose name is the current name or a synonym of one of those tags keeps that id. Any other typed name is looked up at any level (`findByName('tag', name)`: a main name beats a synonym, then the oldest tag), and only a name found nowhere creates a new top-level tag. Chips keep showing the bare name.

---

## 7. State

`useTagsStore` grows write-through actions (persist through the repositories, then `load()` again), as `useAccountsStore` does: create, save, merge, delete, restore; and reads the dialogs need: `usageCount`, `detailConflicts`, the details of one tag, `journeyDates`, and the duplicate groups (re-read with every `load()`). `tags` keeps every row, deleted and merged ones included, so the merged names and the deleted list come from it without extra queries. Edits during a running sync are not frozen yet (TASKS: "Freeze edits while a sync runs").

---

## 8. Testing

- Pure helpers (the tree with its filter, path labels, parent options, merged names, the dialog's draft and validation) get unit tests, like `accountForm.spec.ts`.
- Repository tests: the combined save (all-or-nothing on a name clash at the new parent), `retired_names` (removing, adding back, lookup, carried by a merge), the merge fix.
- `syncColumns.spec.ts` keeps the descriptors in step with the schema; a sync test that a retired name syncs and stops the lookup on the other device too.
- A component test for the page like `AccountsView.spec.ts` (real stores over an in-memory database): create, edit, move, merge with a conflict, delete and restore, duplicates shown, a category in use routed to merge.
- Checked by hand in the browser at phone and desktop width, light and dark.

---

## 9. Left to the builder

Component split and names; exact repository signatures; which PrimeVue inputs carry the chip list and the date pickers; the empty-tab wording; small layout details within the UI rules in CLAUDE.md.
