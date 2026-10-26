# Tags and Categories — Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data layer the category-vs-tag decisions need — tags of five kinds with short ids, hierarchy, side tables, merging, categories split into parts on transactions, and the sync repairs — plus the pure split calculator the transaction form will use.

**Architecture:** One `tags` table with a `kind`, three per-kind side tables, category parts stored as a JSON column on the transaction row (one row = one atomic sync unit, so a split edited on two devices never mixes parts). Kind and hierarchy rules live in repositories (no triggers, no unique indexes — duplicates must survive sync). A post-merge repair pass in the sync engine redirects references to merged tags, lifts children of deleted tags, and undoes parent loops.

**Tech Stack:** TypeScript, wa-sqlite (SQLite JSON1), Vitest, Vue 3 + Pinia (accounts only).

**Spec:** [2026-10-26-category-vs-tag-decisions.md](2026-10-26-category-vs-tag-decisions.md) — read it with this plan.

## Roadmap

This plan is **A** (data layer) plus **S** (split calculator). B and C get their own plans once A lands.

```
S  split calculator (pure) ────────────────────────────────────────────────┐
                                                                           ├─► C transaction form
A1 short ids + tags + side tables ─┬─► A2 accounts & groups ─┐             │   (needs A3, S)
                                   │                         ├─► A4 merge, usage, delete ─► A5 sync repairs ─► docs
                                   └─► A3 transactions ──────┘        │
                                                                      └─► B Tags page (needs A4)
                                                          D reports (category ±, journeys, merchants) after C
```

Waves: **A1 ∥ S**, then **A2 ∥ A3**, then **A4**, then **A5**, then **A6** (sync corner-case tests) and **A7** (pruning them). Parallel tasks run in separate git worktrees off `tags-and-categories`; the controller merges each into the branch after review.

- **B — Tags page:** a tree per kind; create (random colour preset + kind icon for top-level), rename, move, merge (= make synonym, with warning), soft-delete with usage warning, restore; duplicates highlighted; location / merchant / journey details editors.
- **C — Transaction form:** the typed / derived UI rule (CLAUDE.md), split view on S, merchant / location / journey fields, nearest-location matching (~150 m, nearby one-tap choices), merchant → default category, the per-device "on a journey" switch (start new / join ongoing or recent).
- **D — Reports:** category totals with + / − parts, journey / merchant / location aggregation.

## Data model decisions (pinned)

Migration `002_domain_schema.ts` is edited in place (no real data yet). Column comments follow CLAUDE.md.

- **`tags`**: `id TEXT PRIMARY KEY` (short id), `kind TEXT NOT NULL CHECK (kind IN ('category','merchant','location','journey','tag'))`, `name TEXT NOT NULL`, `parent_id TEXT REFERENCES tags(id) ON DELETE RESTRICT` (same kind, repository-checked; NULL = top level), `description TEXT`, `synonyms TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(synonyms))`, `colour TEXT` and `icon TEXT` (NULL = inherit from parent), `merged_into_id TEXT REFERENCES tags(id) ON DELETE RESTRICT` (set together with `deleted_at_utc` when merged), sync columns, `CHECK (parent_id IS NULL OR parent_id <> id)`. Index `idx_tags_parent ON tags(parent_id)`. **No unique index on names.**
- **`location_details`**: `tag_id TEXT PRIMARY KEY REFERENCES tags(id)`, `address TEXT`, `latitude REAL`, `longitude REAL`, `merchant_id TEXT REFERENCES tags(id)` (kind merchant), sync columns.
- **`merchant_details`**: `tag_id` PK/FK, `default_category_id TEXT REFERENCES tags(id)` (kind category), sync columns.
- **`journey_details`**: `tag_id` PK/FK, `start_date TEXT`, `end_date TEXT` (`'YYYY-MM-DD'`; NULL = derived from the journey's transactions), sync columns.
- **`locations`**: dropped. `accounts.location_id` and `transactions.location_id` reference `tags(id)`.
- **`accounts.tags`**, **`transactions.tags`**: JSON arrays of plain-tag (`kind = 'tag'`) ids.
- **`transactions`**: adds `categories TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(categories))` (after `tags`), `merchant_id` and `journey_id` (`REFERENCES tags(id) ON DELETE RESTRICT`). A part is `{"category_id": "<short id>", "amount_value__from": n, "amount_scale__from": n, "amount_value__to": n, "amount_scale__to": n}`; currencies come from the transaction. "At least one" and "parts add up exactly to both totals" are repository rules.
- **Short ids**: tags, accounts, account groups. Transactions keep UUIDv7 (`TRANSACTION_ORDER_BY` breaks ties by `id DESC`); rate tables keep their UUIDv5.
- **Typed vs. derived is not persisted**, except journey dates (stored = typed override, NULL = derived).
- **Kind icons** (PrimeIcons names, no `pi-` prefix): category `tag`, merchant `shop`, location `map-marker`, journey `globe` (PrimeIcons has no plane), tag `hashtag`.

## Global Constraints

- SQLite conventions in CLAUDE.md: only TEXT / INTEGER / REAL / BLOB declarations with semantic comments, sync columns on every domain table, `ON DELETE RESTRICT`, migration `up` starts with a statement keyword.
- Every synced table is in `SYNC_TABLES` (parents first) and `SYNC_COLUMNS`; `syncColumns.spec.ts` must pass.
- Domain types use `ShortId` / `UUID` / `Date` / `MoneyAmount` / `LocalMoment`; repositories marshal through `src/db/columnMappers.ts`.
- Writes that touch several rows run in one `db.transaction(async (tx) => …)`, using only `tx` inside.
- Short id: exactly 12 characters from `0-9A-Za-z`, from `crypto.getRandomValues` with rejection sampling (bytes ≥ 248 discarded) — never `Math.random`.
- Rounding in S is half-to-even.
- Commands: `npm run test:unit -- --run <path>`, `npm run type-check`, `npm run lint` (auto-fixes). Not `npx vitest`.
- In a fresh worktree run `npm ci` first.
- Commit style `feat(tags): …` / `refactor(accounts): …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commits that edit migration 002 say "Migration 002 is edited in place: reset local IndexedDB and any test remote."

## Review Focus

1. Two devices create the same tag name offline — both rows must survive the merge (A5 test `keeps duplicate tag names from two devices`).
2. Sync combines two moves into a parent loop — the later move is undone to its other-side parent, not to top level (A5 test `undoes the later move of a parent loop`).
3. Merging a tag into its own descendant — refused with the path (A4 test `refuses to merge a tag into its own descendant`).
4. A device tags with X while another merges X into Y — after sync the reference is Y (A5 test `redirects references to a tag merged on another device`).
5. Parts that do not add up, and parts of one category meeting in a merge — rejected / summed exactly (A3 `rejects parts that do not add up`, A4 `sums parts of the merged categories`).
6. Renaming a tag used on an account — the account shows the new name (A2 test `shows a renamed tag on the account`).

---

### Task S: Split calculator

**Files:**
- Create: `src/money/split.ts`, `src/money/__tests__/split.spec.ts`
- Modify: `src/format/currency.ts` (export `usualDecimals`)

**Interfaces:**
- Produces (for plan C):
  ```ts
  export type Side = 'from' | 'to'
  export interface SplitAmounts { from: MoneyAmount; to: MoneyAmount }
  export interface Typed { from: boolean; to: boolean }
  export interface SplitPart { key: string; amounts: SplitAmounts; typed: Typed }
  export interface SplitState { total: SplitAmounts; totalTyped: Typed; parts: SplitPart[] }
  export type SplitWarning =
    | { kind: 'rate-mismatch'; keys: string[] }
    | { kind: 'sum-mismatch'; side: Side; difference: MoneyAmount }
  export const PART_EXTRA_SCALE = 4
  export function emptySplit(currencyFrom: string, currencyTo: string): SplitState
  export function typeTotal(s: SplitState, side: Side, amount: MoneyAmount): SplitState
  export function resetTotal(s: SplitState, side: Side): SplitState
  export function addPart(s: SplitState, key: string): SplitState
  export function removePart(s: SplitState, key: string): SplitState
  export function typePart(s: SplitState, key: string, side: Side, amount: MoneyAmount): SplitState
  export function resetPart(s: SplitState, key: string, side: Side): SplitState
  /** marketRate: units of the `to` currency per 1 unit of `from`; null = none known. */
  export function recompute(s: SplitState, marketRate: number | null): { state: SplitState; warnings: SplitWarning[] }
  /** Rounded to the currency's usual decimals, for display only. */
  export function displayAmount(amount: MoneyAmount): MoneyAmount
  ```
  Mutators only change values and `typed` flags; `recompute` fills every derived value.

**Rules `recompute` implements** (spec §2.4):
1. A total side not typed = the typed side converted at `marketRate`, rounded to the currency's usual decimals (a real amount). No typed side or no rate → zero.
2. The transaction's own rate is `total.to / total.from`, computed exactly in BigInt on unscaled values; each computed value is rounded once.
3. Parts are stored at `usualDecimals(currency) + PART_EXTRA_SCALE`.
4. Per side: typed values are fixed. A part typed on the other side only is *anchored*: its ideal value = the other side at the transaction's rate. A part typed on neither side is *free*. Remainder = total − typed; anchored parts take their ideal values; free parts share what is left equally, the last free part absorbing the rounding unit so the side adds up exactly.
5. No free parts and anchored ideals that miss the remainder → the sums win: the anchored parts share the difference in proportion to their ideals (last one absorbs rounding); every part whose value differs from its ideal by at least half a minor unit of its currency goes into one `rate-mismatch` warning.
6. Every part typed on a side and the sum ≠ total → `sum-mismatch` for that side with `difference = total − sum`.
7. Either total zero → anchored parts count as free (no rate).

- [ ] **Step 1: Write the failing tests** — `split.spec.ts`, using EUR (2 decimals) → AMD (2 decimals per ISO 4217), `marketRate = 398`:
  - `derives the total's other side from the market rate` — `typeTotal(to, 800 AMD)` → `total.from` = 2.01 €.
  - `shares untouched parts equally at extra precision` — two parts → each `from` = 1.005000 (value 1005000, scale 6), `to` = 400.000000; `displayAmount` of 1.005000 € is 1.00 € (half-to-even).
  - `walks the worked example of the spec` — the five steps of §2.4: step 3 (Gifts `to` typed 600) → Gifts `from` 1.507500, Groceries 0.502500 / 200; step 4 (`total.from` typed 2.21) → Gifts 1.657500, Groceries 0.552500; step 5 (Groceries `from` typed 0.60) → Gifts `from` 1.610000, Groceries `to` 200.000000, one `rate-mismatch` with keys `['groceries', 'gifts']` (any order). Display values match the spec's table.
  - `absorbs rounding in the last free part` — total 1.00 € / 1.00 €, three parts → 0.333333, 0.333333, 0.333334; each side sums to exactly 1.00.
  - `warns when typed parts do not add up` — every part typed on `from`, sum 2.00 vs total 2.21 → `sum-mismatch` side `from`, difference 0.21 €.
  - `treats anchored parts as free when a total is zero`.
  - `resetPart makes a typed value derived again`.
- [ ] **Step 2:** `npm run test:unit -- --run src/money/__tests__/split.spec.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement `src/money/split.ts`; export `usualDecimals` from `src/format/currency.ts`.
- [ ] **Step 4:** Run the spec — PASS; `npm run type-check`, `npm run lint`.
- [ ] **Step 5:** Commit `feat(money): split calculator for category parts`.

---

### Task A1: Short ids, tags of five kinds, side tables

**Files:**
- Create: `src/db/shortId.ts`, `src/db/__tests__/shortId.spec.ts`, `src/db/repositories/TagDetailsRepository.ts`, `src/db/repositories/__tests__/TagDetailsRepository.spec.ts`, `src/tags/look.ts`, `src/tags/__tests__/look.spec.ts`, `src/db/errors.ts`
- Modify: `src/db/migrations/002_domain_schema.ts` (tags, side tables, drop locations, location FKs), `src/db/types.ts` (Tag, TagKind, details types; remove Location; `Account.location_id` and `Transaction.location_id` → `ShortId | null`), `src/db/columnMappers.ts` (short-id mappers), `src/db/repositories/TagsRepository.ts` (rewrite) + its spec, `src/db/repositories/AccountsRepository.ts` (location_id mapper only), `src/db/repositories/TransactionsRepository.ts` (location_id mapper only), `src/db/init.ts` (tag-details getter; locations getter removed), `src/sync/syncTables.ts`, `src/sync/syncColumns.ts`, `src/db/__tests__/domainSchema.spec.ts`, `src/sync/__tests__/syncTables.spec.ts` if it lists tables, sync test fixtures that insert `locations` or name-keyed `tags`
- Delete: `src/db/repositories/LocationsRepository.ts` and its spec

**Interfaces:**
- Produces:
  ```ts
  // shortId.ts
  export type ShortId = string & { readonly __brand: 'ShortId' }
  export const SHORT_ID_LENGTH = 12
  export function newShortId(): ShortId
  export function asShortId(value: string): ShortId
  // columnMappers.ts
  export function shortIdFromColumn(text: string): ShortId
  export function shortIdFromNullableColumn(text: string | null): ShortId | null
  // types.ts
  export type TagKind = 'category' | 'merchant' | 'location' | 'journey' | 'tag'
  export interface Tag { id: ShortId; kind: TagKind; name: string; parent_id: ShortId | null; description: string | null; synonyms: string[]; colour: string | null; icon: string | null; merged_into_id: ShortId | null; created_at_utc: Date; updated_at_utc: Date; deleted_at_utc: Date | null }
  export interface LocationDetails { tag_id: ShortId; address: string | null; latitude: number | null; longitude: number | null; merchant_id: ShortId | null }
  export interface MerchantDetails { tag_id: ShortId; default_category_id: ShortId | null }
  export interface JourneyDetails { tag_id: ShortId; start_date: string | null; end_date: string | null }
  // errors.ts — each extends Error
  export class TagKindMismatchError, DuplicateTagNameError, TagLoopError /* .path: string[] (names, ancestor first) */, CategoryInUseError /* A4 */, PartsSumError /* A3 */
  // TagsRepository
  create(input: { kind: TagKind; name: string; parent_id?: ShortId | null; description?: string | null; synonyms?: string[]; colour?: string | null; icon?: string | null }): Promise<Tag>
  findById(id: ShortId): Promise<Tag | null>          // live only
  listAll(): Promise<Tag[]>                            // including deleted and merged
  list(kind?: TagKind): Promise<Tag[]>                 // live, ordered by name
  findByName(kind: TagKind, name: string, parentId?: ShortId | null): Promise<Tag | null> // name or synonym, case-insensitive, live; parentId undefined = any parent
  update(id: ShortId, patch: { name?: string; description?: string | null; synonyms?: string[]; colour?: string | null; icon?: string | null }): Promise<void>
  move(id: ShortId, parentId: ShortId | null): Promise<void>
  softDelete(id: ShortId): Promise<void>               // children move up to its parent
  restore(id: ShortId): Promise<void>                  // refuses merged tags; a deleted parent → top level
  duplicates(): Promise<ShortId[][]>                   // live groups sharing kind + parent + a name/synonym, case-insensitive
  // TagDetailsRepository
  getLocation(id) / setLocation(id, d: Omit<LocationDetails, 'tag_id'>)
  getMerchant(id) / setMerchant(id, d) ; getJourney(id) / setJourney(id, d)
  nearestLocations(lat: number, lon: number, radiusMetres: number, limit: number): Promise<{ tag: Tag; metres: number }[]>
  // look.ts
  export const KIND_ICONS: Record<TagKind, string>
  export function newTagLook(kind: TagKind, random?: () => number): { colour: string; icon: string }
  export function effectiveLook(tag: Tag, byId: ReadonlyMap<ShortId, Tag>): { colour: string; icon: string }
  ```
- Name rule: names and synonyms are unique among **live** tags of the same kind and parent, compared with `toLocaleLowerCase()`; checked on create / update / move only (sync may bring duplicates in).
- `effectiveLook` walks up parents for the first non-null colour / icon; with none, colour = `ACCOUNT_COLOURS[hash(id) % length]` (deterministic), icon = `KIND_ICONS[kind]`. `newTagLook` picks a random preset.

- [ ] **Step 1: Write failing tests**
  - `shortId.spec`: matches `/^[0-9A-Za-z]{12}$/`; 10 000 ids unique; `crypto.getRandomValues` is called (spy).
  - `domainSchema.spec`: tables now `accounts, transactions, exchange_rates, tags, location_details, merchant_details, journey_details, account_groupings, applied_rates` (no `locations`); `kind = 'shop'` rejected by CHECK; `parent_id` pointing nowhere rejected; `accounts.location_id` FK to `tags`.
  - `TagsRepository.spec`: `creates a child of the same kind`; `refuses a parent of another kind` (TagKindMismatchError); `refuses a duplicate name among live siblings, synonyms included, ignoring case`; `allows the same name in another kind or under another parent`; `refuses to move a tag under its own descendant` (TagLoopError, `path` = `['X', 'A', 'Y']`); `rename keeps the id`; `softDelete moves children up to the deleted tag's parent`; `restore puts a tag whose parent is deleted at the top level`; `finds by synonym ignoring case`; `lists duplicates inserted by sync` (rows inserted with raw SQL).
  - `TagDetailsRepository.spec`: `refuses location details on a merchant`; `refuses a location's merchant that is not a merchant`; `finds nearest locations within the radius, nearest first, live only` (three points: 50 m, 140 m, 400 m → two results).
  - `look.spec`: inherits from the nearest ancestor that sets a value; falls back to the kind icon and a stable preset colour; `newTagLook` uses the injected random.
- [ ] **Step 2:** Run the specs — FAIL.
- [ ] **Step 3:** Implement: schema, types, mappers, repositories, look, sync descriptors (order: `tags`, `location_details`, `merchant_details`, `journey_details`, `applied_rates`, `account_groupings`, `accounts`, `transactions`), init getters; delete LocationsRepository. Fix fixtures that inserted `locations` / name-keyed `tags`.
- [ ] **Step 4:** `npm run test:unit -- --run`, `npm run type-check`, `npm run lint` — all green.
- [ ] **Step 5:** Commit `feat(tags): five kinds, short ids, hierarchy and side tables` (with the migration-edit sentence).

---

### Task A2: Accounts and groups on short ids; account tags as ids

**Files:**
- Modify: `src/db/types.ts` (Account / AccountGrouping ids, `grouping_id`, `Account.tags: ShortId[]`, `Transaction.account_id__from/__to: ShortId | null`), `src/db/repositories/AccountsRepository.ts`, `AccountGroupingsRepository.ts`, `TransactionsRepository.ts` (**only** the `account_id__*` mappers and the parameter types of `countByAccountId` / `listByAccountId`), `src/db/balances.ts` (parameter type), `src/stores/accounts.ts`, `src/views/AccountsView.vue`, `src/components/accounts/accountForm.ts`, `src/components/accounts/AccountEditDialog.vue`, their specs
- Create: `src/stores/tags.ts`, `src/stores/__tests__/tags.spec.ts`

**Interfaces:**
- Consumes: A1 `newShortId`, `ShortId`, mappers, `TagsRepository.findByName / create / listAll`, `newTagLook`.
- Produces: `useTagsStore` with `tags: Ref<Tag[]>` (from `listAll`), `byId: ComputedRef<Map<ShortId, Tag>>`, `load()`, `nameOf(id: ShortId): string`, `resolvePlainTags(names: string[]): Promise<ShortId[]>` (finds top-level plain tags by name or synonym, creates missing ones with `newTagLook('tag')`, keeps order, drops duplicates). Plan B extends this store.
- The account dialog keeps editing names; its save resolves them with `resolvePlainTags`; the accounts page shows names via `nameOf` (a deleted tag is not shown).

- [ ] **Step 1: Write failing tests** — `AccountsRepository.spec` / `AccountGroupingsRepository.spec`: new ids match the short-id pattern; `tags.spec`: `resolvePlainTags` creates missing tags once and reuses existing ones (by synonym too); `AccountsView.spec`: `shows a renamed tag on the account` (rename the tag via the repository, reload → new name shown).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full unit run, type-check, lint — green.
- [ ] **Step 5:** Commit `refactor(accounts): short ids, tags by id`.

---

### Task A3: Transactions with category parts, merchant, journey, tag ids

**Files:**
- Modify: `002_domain_schema.ts` (transactions columns), `src/db/types.ts` (`CategoryPart`, Transaction fields), `src/db/columnMappers.ts` (parts mappers), `src/db/repositories/TransactionsRepository.ts` (create / update / validation — not the `account_id__*` lines A2 owns), `src/db/repositories/TagDetailsRepository.ts` (add `journeyDates`), `src/sync/syncColumns.ts` (transactions entry), specs and fixtures that create transactions through the repository
- Test: `TransactionsRepository.spec.ts`, `TagDetailsRepository.spec.ts`, `columnMappers.spec.ts`

**Interfaces:**
- Consumes: A1 tags, `PartsSumError`, `TagKindMismatchError`.
- Produces:
  ```ts
  export interface CategoryPart { category_id: ShortId; amount__from: MoneyAmount; amount__to: MoneyAmount }
  // Transaction gains: categories: CategoryPart[]; merchant_id: ShortId | null; journey_id: ShortId | null; tags: ShortId[]
  export function categoryPartsToColumn(parts: CategoryPart[]): string
  export function categoryPartsFromColumn(text: string, currencyFrom: string, currencyTo: string): CategoryPart[]
  // TagDetailsRepository
  journeyDates(id: ShortId): Promise<{ start: string | null; end: string | null; startTyped: boolean; endTyped: boolean }>
  ```
- Validation on create / update, inside the write's `db.transaction`: at least one part; no category twice; each `category_id` a `category` tag, `merchant_id` a `merchant`, `location_id` a `location`, `journey_id` a `journey`, each of `tags` a `tag`; a reference must be live unless the stored row already has it (deleted tags stay on their transactions); parts' `from` and `to` sums equal the totals exactly (`sumMoney`, scale-aware) — else `PartsSumError`. Part currencies must equal the totals'.
- `journeyDates`: stored override per end, else min / max of `COALESCE(date_override_local, transaction_at_local)` dates (local calendar date, first 10 chars) over live transactions of the journey and its descendants.

- [ ] **Step 1: Write failing tests**: `requires at least one category`; `rejects parts that do not add up` (from side and to side separately); `stores parts at extra precision and reads them back` (1.005000 €); `rejects a merchant that is not a merchant`; `keeps a deleted tag already on the transaction but refuses adding one`; `journeyDates derives from the earliest and latest transaction of the journey and its children` and `prefers stored dates`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; update existing transaction fixtures to pass one category part.
- [ ] **Step 4:** Full unit run, type-check, lint — green.
- [ ] **Step 5:** Commit `feat(transactions): category parts, merchant, journey` (with the migration-edit sentence).

---

### Task A4: Merging, usage and deleting rules

**Files:**
- Create: `src/db/tagReferences.ts`, `src/db/__tests__/tagReferences.spec.ts`
- Modify: `src/db/repositories/TagsRepository.ts` (merge, usageCount, softDelete rule) + spec

**Interfaces:**
- Consumes: A1–A3.
- Produces:
  ```ts
  /** Rewrites every reference to `fromId` into `toId`. `bump`: set updated_at_utc on rewritten rows. */
  export async function redirectTagReferences(tx: SqlExecutor, fromId: ShortId, toId: ShortId, opts: { bump: boolean; now?: string }): Promise<void>
  export async function countTagUsage(db: SqlExecutor, id: ShortId): Promise<number> // live transactions + live accounts referencing it
  // TagsRepository
  merge(sourceId: ShortId, targetId: ShortId): Promise<void>
  usageCount(id: ShortId): Promise<number>
  ```
- References covered: `transactions.merchant_id / location_id / journey_id`, `transactions.tags` (replace, drop duplicates), `transactions.categories` (replace; two parts of the same category become one with both sides summed exactly), `accounts.location_id`, `accounts.tags`, `location_details.merchant_id`, `merchant_details.default_category_id`, `tags.parent_id` (children move to the target). Rows of any liveness are rewritten.
- `merge`: same kind (else TagKindMismatchError); target not in the source's subtree (else TagLoopError with path); in one transaction: redirect with `bump: true`; target's synonyms ∪= source's name + synonyms (minus the target's name, case-insensitive dedupe); source gets `merged_into_id = target`, `deleted_at_utc = now`. Balances need no refresh (amounts unchanged).
- `softDelete` of a category with `usageCount > 0` throws `CategoryInUseError` (the UI merges instead).

- [ ] **Step 1: Write failing tests**: `rewrites every kind of reference`; `sums parts of the merged categories` (Everyday food 5 € + Groceries 3 € → Groceries 8 €, both sides); `moves the source's children under the target`; `adds the source's names as synonyms`; `refuses to merge a tag into its own descendant` (path); `refuses to merge across kinds`; `bumps updated_at_utc of rewritten rows`; `refuses to delete a category in use`; `usageCount counts transactions and accounts`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement (JSON rewrites in TypeScript over rows selected with `json_each`).
- [ ] **Step 4:** Full unit run, type-check, lint — green.
- [ ] **Step 5:** Commit `feat(tags): merge into another tag, delete rules`.

---

### Task A4b: Merging tag details

Added after A4 at the user's decision (spec §2.5, details bullet). Runs in parallel with A5 (disjoint files).

**Files:**
- Modify: `src/db/types.ts` (detail types), `src/db/errors.ts` (`MergeConflictError`), `src/db/repositories/TagsRepository.ts` (`merge`, `detailConflicts`) + spec

**Interfaces:**
- Consumes: A1 `TagDetailsRepository` tables, A4 `merge`.
- Produces:
  ```ts
  export interface TagDetailValues {
    address: string | null
    position: { latitude: number; longitude: number } | null // the two coordinates as one value
    merchant_id: ShortId | null
    default_category_id: ShortId | null
    start_date: string | null
    end_date: string | null
  }
  export type TagDetailField = keyof TagDetailValues
  export interface TagDetailConflict<F extends TagDetailField = TagDetailField> { field: F; source: TagDetailValues[F]; target: TagDetailValues[F] }
  export class MergeConflictError extends Error { constructor(readonly conflicts: TagDetailConflict[]) }
  // TagsRepository
  detailConflicts(sourceId: ShortId, targetId: ShortId): Promise<TagDetailConflict[]>
  merge(sourceId: ShortId, targetId: ShortId, resolved?: Partial<TagDetailValues>): Promise<void>
  ```
- Fields by kind: location → `address`, `position`, `merchant_id`; merchant → `default_category_id`; journey → `start_date`, `end_date`. Other kinds have none.
- Per field: a value in `resolved` wins (it may be a third value, or `null`); otherwise the target's value if it has one and the source's is equal or absent; otherwise the source's. Both present and different, and not in `resolved` → `merge` throws `MergeConflictError` with every such field before changing anything. The target's details row is created if missing and written in the merge's transaction (`updated_at_utc` bumped).

- [ ] **Step 1: Write failing tests**: `fills the target's empty details from the source`; `treats equal values as no conflict`; `refuses a conflicting merge without a resolution` (MergeConflictError lists `address` and `position`, nothing changed); `stores a resolved third value`; `detailConflicts lists the differing fields`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Full unit run, type-check, lint — green.
- [ ] **Step 5:** Commit `feat(tags): merging tag details asks on conflict`.

---

### Task A5: Sync repairs for tags

**Files:**
- Create: `src/sync/repairTags.ts`, `src/sync/__tests__/repairTags.spec.ts`
- Modify: `src/sync/mergeEngine.ts`, `src/sync/csvCodec.ts` (`importAllTables`), `src/sync/types.ts` (`ConflictResolution` gains `'loop-undone'`), `src/sync/__tests__/mergeDatabases.spec.ts`, `csvCodec.spec.ts`

**Interfaces:**
- Consumes: A4 `redirectTagReferences` (with `bump: false`).
- Produces:
  ```ts
  export type TagSnapshot = ReadonlyMap<string, SyncRow> // tags rows by id
  export async function repairTags(tx: SqlExecutor, before: { local: TagSnapshot; remote: TagSnapshot }): Promise<SyncConflict[]>
  ```
- `mergeDatabases`: run `PRAGMA defer_foreign_keys = ON` first inside its transaction (a child tag may arrive before its parent); snapshot local and remote `tags` before merging; after the table merges and before `recalculateBalances`, call `repairTags`. `importAllTables` defers foreign keys the same way.
- `repairTags`, in order:
  1. **Redirect:** for each tag with `merged_into_id`, follow the chain to its end and `redirectTagReferences(from, end, { bump: false })` — every device computes the same result, so no timestamp moves.
  2. **Lift:** a live tag whose parent is deleted (not merged) moves to the nearest live ancestor or the top level, no bump.
  3. **Loops:** for each parent cycle, take the tag in it with the latest `updated_at_utc`; set its `parent_id` to the other side's pre-merge value (the remote snapshot's if the local row won, else the local one's; NULL if the other side lacks the row); bump its `updated_at_utc`; repeat until no cycle remains (at most one pass per tag; then fall back to NULL). Each undo returns a `SyncConflict` with `resolution: 'loop-undone'`, `table: 'tags'`, the tag id, both snapshot rows.

- [ ] **Step 1: Write failing tests** (`mergeDatabases.spec` / `repairTags.spec`): `merges a child tag that sorts before its parent` (ids chosen so the child's id < parent's); `imports a child tag from an earlier CSV file than its parent`; `keeps duplicate tag names from two devices`; `redirects references to a tag merged on another device` (local transaction and account use X; remote merged X into Y → both use Y; their `updated_at_utc` unchanged); `lifts a tag whose parent was deleted on another device`; `undoes the later move of a parent loop` (local moves A under B at t1; remote moves B under A at t2 > t1 → B's parent is its local pre-merge parent, B's `updated_at_utc` > t2, one `loop-undone` conflict for B).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full unit run, type-check, lint — green.
- [ ] **Step 5:** Commit `feat(sync): repair merged, orphaned and looping tags`.

---

### Task A6: Sync corner-case tests

Starts after A5 is merged. Tests only: no production code changes.

**Files:**
- Create: `src/sync/__tests__/syncCornerCases.spec.ts` (split into a few files under `src/sync/__tests__/cornerCases/` if it passes ~600 lines)

**Interfaces:**
- Consumes: `mergeDatabases`, `repairTags`, `hashDatabase`, `importAllTables` / `exportAllTables`, the repositories, the in-memory fakes in `src/sync/__tests__/fakes.ts` and `helpers.ts`.

**What to write:** scenarios with two (sometimes three) devices that each start from a common database, change it offline, then sync in some order. Every scenario asserts the **convergence invariant** — after every device has synced with the final remote, all databases have the same `hashDatabase` — plus its own expectation. Seed list (add more you find):
- the same transaction's split edited on both devices (one complete split wins, never a mix);
- a transaction added to a category that the other device deleted / merged away;
- X merged into Y on one device while the other merges Y into X; chains X → Y → Z merged on different devices;
- a tag moved under a parent the other device deleted; three-tag parent loops; a loop combined with a merge;
- duplicates of a name created on two devices, then one renamed;
- a soft-deleted tag restored on one device while the other edits it;
- a child tag whose id sorts before its parent's, through the CSV round trip and through `mergeDatabases`;
- the account balance cache after merges touching both legs of a transfer;
- equal timestamps on both sides (clock ties) — the result must still converge;
- optional text `''` vs NULL, JSON columns with non-ASCII names, through the CSV round trip.

A scenario that exposes a real bug stays in the file as `it.fails(...)` with a `// BUG:` comment saying what goes wrong, and goes into the report's bug list — never "fix" it by weakening the assertion.

- [ ] Write the scenarios; run `npm run test:unit -- --run src/sync/__tests__/`; full unit run, type-check, lint, format.
- [ ] Commit `test(sync): corner cases of tags, splits and merges`.

### Task A7: Prune the corner-case tests

A reviewer agent reads A6's tests and drops (or merges) the ones that make no sense: duplicates of each other or of existing specs, scenarios the spec rules out, assertions that only restate the implementation, flaky timing. It keeps every `it.fails` bug scenario unless it is wrong about the spec. It reports what it dropped and why, and commits `test(sync): prune corner-case tests`.

The controller triages A6's bug list: each real bug becomes a fix task before the final review.

### Task F1: Fix the sync corner-case bugs

From A6's bug list as triaged by A7 and the controller. The cutoff bug (`cutoff.spec.ts`) is postponed — see [2026-10-26-sync-change-detection.md](2026-10-26-sync-change-detection.md); leave its two `it.fails` alone.

**Files:** `src/sync/repairTags.ts`, `src/sync/syncColumns.ts` (`ROW_RANK`), `src/db/tagReferences.ts`, `src/db/repositories/TagsRepository.ts`, `src/db/migrations/002_domain_schema.ts` + `syncColumns.ts` + `types.ts` (`moved_at_utc`), the seven `it.fails` below (turned into `it`), unit specs for each rule.

Each fix turns its `it.fails` into a passing `it`:
1. `categories.spec.ts:30`, `:59` — a live transaction must never end with no live category (§2.2, §2.5 "a category in use cannot be deleted"). New repair step after the redirect and before the lift: every deleted, unmerged category that a live transaction references is restored (`deleted_at_utc = NULL`), stamped `updated_at_utc = its deleted_at_utc + 1 ms` (deterministic, so every device writes the same row), and reported as a `SyncConflict` (`resolution: 'delete-undone'`).
2. `categories.spec.ts:121` — a merged tombstone outranks a plain one: `ROW_RANK.tags = row => row.merged_into_id == null ? 0 : 1` (delete-wins still runs first; this decides only between two tombstones).
3. `merges.spec.ts:102` — a merge-cycle restore is stamped `max(cycle's latest updated_at_utc, the live-side row's updated_at_utc) + 1 ms`.
4. `merges.spec.ts:253` — a user merge (`redirectTagReferences` with `bump: true`) rewrites deleted rows without bumping them; only live rows are bumped.
5. `merges.spec.ts:28` (spec question, ruled) — names merged along a chain stay findable: `TagsRepository.findByName` also matches the name and synonyms of merged tombstones and returns the live end of their merge chain. Stored synonyms are not rewritten by sync (so a synonym the user removed later is not resurrected). Adjust the test's final assertion to the lookup if it asserts the stored synonym list.
6. `hierarchy.spec.ts:114` (spec question, ruled) — a parent loop is undone at the tag **moved** last: new column `tags.moved_at_utc TEXT NOT NULL -- ISO 8601 UTC instant: when parent_id was last set by the user`, set on create (= `created_at_utc`), on `move`, and on children re-parented by `merge`; repairs (redirect, lift, loop undo) leave it alone. The loop rule picks the greatest `moved_at_utc` (ties: greatest id).

- [ ] Turn each `it.fails` into `it`, see it fail, fix, see it pass; unit tests for the new rule pieces; full unit run, type-check, lint, format.
- [ ] Commit `fix(sync): repair categories in use, merged tombstones, restore stamps, move order` (with the migration-edit sentence).

### Finish (controller)

- Update CLAUDE.md SQLite conventions (short ids, `tags` keyed by id, the `categories` JSON column, new sync tables), TASKS.md (A done; B, C, D ahead), the decisions doc (journey icon `globe`).
- Whole-branch review; merge to `main` when the user asks.
