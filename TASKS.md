# Tasks

Single source of truth for what's built and what's still ahead. Synthesized from [REQUIREMENTS.md](REQUIREMENTS.md) and the plans under [docs/plans/](docs/plans/).

When a feature lands, move its bullet from **To Do** to **Done** with a one-line pointer to the plan or commit that delivered it.

---

## Done

### Project scaffolding

- Vue 3 + TypeScript + Vite
- Tailwind CSS v4 (Vite plugin, CSS-first config)
- PrimeVue component library + PrimeIcons (Aura preset default; Material / Lara / Nora available)
- Pinia, Vue Router
- vite-plugin-pwa (installable, service worker, web manifest)
- oxlint + ESLint + Prettier
- Vitest + Vue Test Utils
- Playwright e2e scaffold (the one spec is still the create-vue default and fails; not run in CI — see To Do)
- GitHub Actions: lint + type-check + unit tests on PR
- GitHub Pages deploy on merge to `main` (build emits a `404.html` copy so deep links work)
- Plans: [2026-02-22-tech-stack-design](docs/plans/2026-02-22-tech-stack-design.md), [2026-02-27-project-scaffold](docs/plans/2026-02-27-project-scaffold.md)

### Navigation & layout

- Positionable nav (top / bottom / left / right / auto)
    - Responsive default: left sidebar on desktop (≥768px), top bar on mobile
- Collapsible sidebar
    - Modes: always collapsed, opens on hover, always expanded
    - Pin/unpin toggle button (resets on reload)
    - Chevron direction flips for right-positioned sidebar
- Components: `AppLayout`, `AppMenubar`, `AppSidebar`
- `useLayoutStore` (Pinia) — nav position, collapse mode, nav items, temporary toggle
- Settings page: theme preset switcher, dark mode toggle, nav position, sidebar mode
- Placeholder routed pages: Home, Page Two, About, Settings
- Plans: [2026-03-08-nav-position-design](docs/plans/2026-03-08-nav-position-design.md), [2026-03-08-nav-position-plan](docs/plans/2026-03-08-nav-position-plan.md)

### Persistence layer

- wa-sqlite (WASM SQLite) running client-side
- IDBBatchAtomicVFS — IndexedDB-backed persistence (the design originally targeted OPFS; IDB-backed VFS replaced it)
- Async WASM build + mutex for Asyncify safety (no concurrent ops on a single connection)
- No COOP/COEP headers needed: IDBBatchAtomicVFS does not require cross-origin isolation (`coi-serviceworker` was removed in `23c72f4`)
- `Database` class — `init`, `exec`, `run`, `transaction`, `close`, `isOpen`
- Versioned migration runner backed by a `migrations` table
- `001_settings` migration + `SettingsRepository`
- Layout store hydrates from SQLite on bootstrap (invalid stored values fall back to defaults) and persists across reloads; visual settings save optimistically and revert on failure
- `Database.init()` enables `PRAGMA foreign_keys = ON`
- Plans: [2026-03-15-persistence-layer-design](docs/plans/2026-03-15-persistence-layer-design.md), [2026-03-15-persistence-layer-plan](docs/plans/2026-03-15-persistence-layer-plan.md)

### Domain schema & repositories

- UUIDv7 helper (`src/db/uuid.ts`, branded `UUID` type)
- Value types
    - `MoneyAmount` — BigDecimal-style `value` + `scale` + `currency`
    - `LocalMoment` — offset-bearing ISO 8601 + IANA zone name
- Column mappers — Money, LocalMoment, JSON arrays, JSON objects, instants, UUIDs
- `002_domain_schema` migration creates six tables with hard FKs:
    - `locations` (since replaced by location tags, see "Tags and categories — data layer")
    - `tags` (natural string PK; since then short ids, see the same section)
    - `accounts`
    - `exchange_rates` (per-provider rows; id is a UUIDv5 of (date, base currency, provider), so one row per key and two devices' copies merge as one row)
    - `account_groupings` (membership: `accounts.grouping_id`, one group per account)
    - `transactions` — double-entry, nullable from/to legs for "Global Economy" income/spend
- Sync columns on every domain table: `created_at_utc`, `updated_at_utc`, `deleted_at_utc`
- Soft-delete pattern; repos filter out deleted rows by default
- Repositories for all six entities (create / find / list / update / softDelete + entity-specific queries)
- Repositories wired into `src/db/init.ts`
- SQLite conventions promoted into [CLAUDE.md](CLAUDE.md)
- Plan: [2026-05-20-database-schema-plan](docs/plans/2026-05-20-database-schema-plan.md)

### Database sync — merge engine & orchestration core

The offline-testable core of database sync, with no real network or
serialization adapter yet (those are the next plan).

- `src/sync/` module — types, localStorage device id + last-known-remote-state,
  schema-version gate, FK-ordered table descriptors, generic row helpers
  (read / compare with byte-by-byte `Uint8Array` support / upsert via
  `INSERT … ON CONFLICT DO UPDATE`), delete-wins + latest-timestamp-wins
  conflict resolution
- Single-transaction full-database merge with parent-before-child ordering and
  rollback on FK violation
- `SyncProvider` + `DatabaseCodec` interfaces — later collapsed into the single
  `SyncBackend` interface (see the backends section)
- `syncOrchestrator` — pure `decideSync` scenario logic + `runSync` covering
  first-sync, identical-DB short-circuit, scenario 2.1 upload, scenario 2.2
  merge-and-CAS (lost races retried from scratch, at most 5 attempts with
  backoff), schema gate (`abort-app-outdated` when the
  remote is newer)
- In-memory fakes for unit tests (now `FakeSyncBackend` & co. in `src/sync/__tests__/fakes.ts`)
- 49 Vitest tests covering every algorithm branch (concurrent CAS re-merge,
  delete-wins-over-newer-edit, FK-violating rollback, conflict snapshot capture)
- Scenarios: [2026-05-22-database-sync-scenarios](docs/scenarios/2026-05-22-database-sync-scenarios.md)
- Plan: [2026-05-22-database-sync-plan](docs/plans/2026-05-22-database-sync-plan.md), commit `8687e17`

### Database sync — settings UI, identity, and provider credentials

The localStorage scaffolding, Settings UI, and `deviceName` identity from
the sync-settings design. The real `SyncProvider` and the app-launch
remote fetch are still ahead (see "External sync" below).

- `src/sync/localState/` directory — `storage.ts` (jsonStore / nullableJsonStore /
  stringStore with `moneytracker.sync.` key prefix; reads merge over a deep copy
  of the default, one level deep, and tolerate unreadable storage), `deviceName.ts` (UA-derived default + 8-char
  random hex suffix from `crypto.getRandomValues`), `remoteSnapshots.ts`
  (lastKnownRemoteState + lastFetchedRemoteSnapshot), `providerConfig.ts`
  (Supabase / S3-compatible / GitHub types + `EMPTY_PROVIDER_CONFIG`), plus
  a barrel `index.ts` preserving the existing import path
- `SyncMetadata.device` / `RemoteState.device` / `SyncDeps.deviceName` —
  renamed from the old UUIDv7 `deviceId`; merge logic unchanged because the
  field is opaque
- Backend registry in `src/db/init.ts` (`getSyncBackend` / `setSyncBackend` /
  `applyProviderConfig`; originally a `DatabaseCodec` slot) — reactive, rebuilt
  whenever the provider config is saved
- `useSyncSettings` composable + three new Divider sections in
  `SettingsView.vue` (This device, Sync status, Sync provider). Settings never
  triggers a network call — the remote row reads only from
  `lastFetchedRemoteSnapshot`
- 40 new Vitest tests covering each storage helper, the UA parser, the
  default-name suffix, snapshot round-trips, provider-config forward
  compatibility, and the composable's reactive behaviour
- Design: [2026-05-27-sync-settings-design](docs/plans/2026-05-27-sync-settings-design.md)
- Plan: [2026-05-28-sync-settings-plan](docs/plans/2026-05-28-sync-settings-plan.md)

### Database sync — GitHub-CSV and SQLite-blob backends

Both SyncBackend implementations, the unified interface, shared content
hashing, and a minimal "Sync now" trigger so the backends can be
exercised end-to-end.

- `SyncBackend` interface (`src/sync/SyncBackend.ts`) replaces the
  previous `SyncProvider` + `DatabaseCodec` seam; the orchestrator no
  longer sees how many files a backend stores.
- Shared content-based `hashDatabase` (`src/sync/hashDatabase.ts`) with
  a `WeakMap` cache keyed on `Database.mutationCounter`. Same logical DB
  yields the same hash across backends.
- `csvCodec` — PapaParse for serialisation, one bulk
  `INSERT … SELECT json_extract(…) FROM json_each(?)` per table on
  import (one Asyncify yield-point per table instead of one per row).
- `GitHubCsvBackend` — REST data API; CAS via `PATCH /git/refs` with
  `force: false`; base_tree preserves any unrelated files in the repo;
  bootstraps empty repos via `POST /git/refs`.
- `sqliteBlobCodec` — `VACUUM INTO` + MemoryVFS round-trip.
- `SqliteBlobBackend` with two transports: `SupabaseStorageTransport`
  (REST + If-Match) and `S3Transport` (aws4fetch sig v4, R2/B2/MinIO
  compatible).
- `backendFactory` wires `providerConfig` → `SyncBackend`; `init.ts`
  registers the backend at app launch.
- Settings UI: per-provider "Validate" button doing an auth-only ping;
  "Sync now" button with inline error display (`lastSyncError`
  localState slot).
- Design: [2026-05-28-sync-backends-design](docs/plans/2026-05-28-sync-backends-design.md)
- Plan: [2026-05-28-sync-backends-plan](docs/plans/2026-05-28-sync-backends-plan.md)

### Review fixes (2026-10-18, before the first live sync)

- Transactions sort by the real instant (`julianday`) with a caller-chosen
  mode — `transaction_at` or `effective` (date override, else
  `transaction_at`) — each backed by an expression index; `id` breaks ties
- `002`: CHECK that `date_override_local`/`_zone` are set together; semantic
  column comments
- `exchange_rates` ids are UUIDv5 of (date, base currency, provider)
- `Database.transaction(fn)` holds the connection lock for the whole unit;
  used by the sync merge, CSV import/export and the migration runner (an app
  write during a sync can no longer be rolled back with it)
- Sync: bounded retries with backoff; every request `no-store` + timeout;
  database-hash cache race fixed; "Sync now" reports an aborted sync
  (remote from a newer app) and shows a summary incl. conflicts; the backend
  follows provider changes without a reload; one sync at a time across
  page instances
- Startup survives unreadable/malformed sync settings; loaded settings no
  longer mutate shared defaults; hydrated layout settings are validated
- UI: real router links with active state, accessible names, `dvh`,
  dark-mode border, loading placeholder and a startup error screen with
  Reload; papaparse/aws4fetch load on demand
- Baseline: tests run on Node ≥ 25 (jsdom storage), committed
  `.oxlintrc.json`, CI type-check, a test that could never fail fixed,
  rollback / UUIDv7-ordering / constraint-specific tests added

### Accounts UI (list, edit, groups, reorder)

- `/accounts` page (nav item "Accounts"): groups as blocks holding their
  accounts, accounts in no group below them; colour + icon badge, currency
  and tags, an Edit button per row (label from `sm` up); empty state
- A group block's background is derived from the group colour, not picked:
  its hue at the neutral block's OKLCH lightness, one shade per theme
  (`groupTint.ts`; chroma lowered to fit sRGB near white/black)
- Create / edit dialog: name, currency (suggests codes in use, then ISO 4217,
  each with its symbol and name; searchable by code or name; custom codes
  like BTC allowed), icon (quick picks + the icon dialog: every pack icon,
  emoji, a word, a picture — see Icons), colour (presets + custom), free-form tags. New accounts
  start at a zero balance (no starting-balance field)
- `src/format/currency.ts`: `currencySymbol` / `currencyName` via `Intl`
- Delete with an inline confirmation; refused while live transactions use
  the account (a soft delete skips the FK check)
- Reorder mode (all grouping is behind it): add / edit / delete groups (name,
  icon, colour; deleting keeps its accounts, they move below the groups),
  reorder groups, reorder accounts and move them between groups. Drag and
  drop with a mouse (native, whole row) or a finger/pen (from the grip,
  `usePointerDrag`: the grip has `touch-action: none` so it never scrolls,
  the rest of the list still does; a 100 ms hold guards against brushes;
  auto-scroll near the edges) — onto an account, a group header, an empty
  group, or (a group) anywhere on another group's block. Native dragging is
  off where no fine pointer exists, so it cannot fight the finger drag.
  Up/down buttons for touch and keyboard — an account's arrows run through
  the whole page, crossing into the neighbouring group. Focus follows the
  moved row, moves are announced
- Schema (`002` edited in place; synced): `account_groupings.sort_order`;
  `accounts.grouping_id` (FK, NULL = no group) + `accounts.sort_order`
  (position within its group). New accounts append to their group;
  `AccountsRepository.arrange(groupingId, ids)` and a `grouping_id` change in
  `update()` place accounts, writing only rows whose place changed;
  `AccountGroupingsRepository.softDelete` re-homes the group's accounts in
  the same transaction. An account pointing at a deleted group (sync race)
  shows with the ungrouped ones
- `useAccountsStore` (Pinia, write-through: persist, then re-read): accounts,
  groups and the `sections` the page renders

### Base currency setting

- Settings → Money → Base currency: default EUR, any code (ISO suggestions
  with symbol and name, or a custom one like BTC). Device-local like every
  setting: SQLite `settings` key `money.baseCurrency`, `useMoneySettingsStore`
  (write-through, hydrated at startup; an invalid stored value falls back to EUR)
- Shared `CurrencyInput` component and currency-code helpers
  (`currencyCodeError`, `normaliseCurrencyCode`, `currencySuggestions` in
  `src/format/currency.ts`), used by the account dialog too
- Used by the Accounts page: ≈ amounts and mixed-currency totals are shown
  in it (see "Account balances")

### Account balances (cache)

- `accounts.balance_value` / `balance_scale` cache each account's balance
  in its own currency, from its live transactions (incoming minus outgoing,
  exact across scales; legs in another currency are not its money). Display
  and totals only, never financial truth. `recalculateBalances`
  (`src/db/balances.ts`) rebuilds it: on every transaction create / update /
  delete (same database transaction, every account touched before and
  after), after every sync merge, and on demand. It never bumps
  `updated_at_utc`
- Sync: `DERIVED_COLUMNS` (`src/sync/syncColumns.ts`) — the merge comparison
  and the database hash skip the cache, and `mergeDatabases` rebuilds it in
  its transaction, so devices converge without false conflicts
- An account that transactions use cannot change its currency: the dialog
  shows it read-only (code, symbol, name, transaction count) instead of the
  picker; the store refuses it too
- Accounts page: each account shows its balance in its own currency, plus
  ≈ the base currency (smaller) when that is another. A group header shows
  its accounts' sum: natively when they share one currency (+ ≈ base when
  it is another), only ≈ base when mixed; the page total the same over all
  accounts. Currencies without a rate are named ("no AED, BTC → EUR rate",
  beside the amount or below it); a mixed total then sums the rest as a bound:
  "≥ €3,491" when every left-out balance is ≥ 0, "≤" when ≤ 0, no amount
  when they have both signs
- Yellow "Recalculate balances" button below the list (all accounts) and
  "Recalculate" next to Delete in the account dialog (that account); both
  say whether anything was off
- Conversions use today's applied exchange rates (see Exchange rates — phase 1)

### Exchange rates — phase 1

Per [docs/plans/2026-10-25-exchange-rates-decisions.md](docs/plans/2026-10-25-exchange-rates-decisions.md):

- Providers in code with a `priority` (`src/money/providers.ts`; equal = one
  level): `manual` 0, central banks 10 (phase 2), fawazahmed0 20,
  openexchangerates 30 (phase 3)
- Pure resolution rules (`src/money/resolveRate.ts`): per level a direct rate
  (either direction), else a cross through one currency (legs may come from
  two providers of the level), else the next level; newest rate on or before
  the day, up to 7 days back; `isFinal` / `isBetter` keep rows from
  downgrading
- fawazahmed0 provider: its EUR file only (the other bases are crosses), CDN
  then the Pages mirror, `latest` for today and yesterday (fetched past the
  browser cache: jsDelivr marks it cacheable for a week), a 30 s timeout per
  request, nothing before 2024-03-02, junk codes dropped
- `applied_rates` (synced): one row per (date, A < B), `rate` (NULL = none
  found), `provider` (`manual` = override, `p1+p2` = cross over two),
  `via`, `reference_date`; repository with `saveAuto` (never over a manual
  row), `setManual`, `removeManual`. Sync: rows devices compute alike are no
  conflict and no hash difference (`EQUALITY_IGNORED_COLUMNS`); a conflict
  goes to the higher `ROW_RANK` — manual > direct > cross > none
- `exchange_rates` is the device-local reference library (out of
  `SYNC_TABLES`; rides along unmerged in a SQLite-blob upload), with `save`
  (upsert), `listBetween`, `newestDate`
- `RateService` (`src/money/rateService.ts`): `ensure` resolves a day's pairs,
  fetching each provider day once per session (concurrent callers share the
  request, failures logged as "nothing there"), NULL rows for pairs nothing
  resolves; `refresh` fetches every provider's newest and re-resolves the last
  8 days' non-final rows; `isStale`
- `useRatesStore`: today's `RateTable`; the Accounts page asks for each
  account currency → base pair in the background and updates when rates
  arrive; "Refresh rates" button beside "Recalculate balances" with a status
  line (a refresh also resolves the pairs in use for the current day, so it
  works across midnight); the app refreshes at start when the newest rate is older than
  yesterday

### Exchange rates — phase 2 (app side)

- Central banks from the rates repo ([xobotun/exchange-rates](https://github.com/xobotun/exchange-rates),
  read from `raw.githubusercontent.com`): one provider per bank — `ecb` EUR,
  `nbg` GEL, `nbk` KZT, `cba` AMD, `cbr` RUB — on level 10, above
  fawazahmed0 (`src/money/providers/centralBanks.ts`). A bank asks for
  `latest` only for today (the repo's `latest` is already today's; every
  earlier day has its own file), nothing before 2019-12-24, and a day the
  repo does not hold yet (404) is nothing found. fawazahmed0 and the banks
  share one file reader (`providers/rateFile.ts`: no-store for `latest`, a
  30 s timeout)
- Provider levels and one rank formula live in `src/money/levels.ts`
  (constants only): `isBetter` and the sync conflict rule (`ROW_RANK`) both
  rank by it — manual, then level, then direct over cross, "none found" last —
  so a central bank's cross is never undone on sync by an aggregator's direct
  rate. The db layer takes `MANUAL_PROVIDER` from there
- Checked in the browser: today's pairs came from the banks in 6 requests
  (five `latest` files, plus fawazahmed0 for a code no bank knows); RUB from
  `cbr` directly, not NBK's cross; a refresh upgraded the previous day's
  fawazahmed0 rows to bank rates


---

### Tags and categories — data layer

- Decided in [docs/plans/2026-10-26-category-vs-tag-decisions.md](docs/plans/2026-10-26-category-vs-tag-decisions.md), built per [docs/plans/2026-10-26-tags-and-categories-plan.md](docs/plans/2026-10-26-tags-and-categories-plan.md)
- One `tags` table for five kinds (category, merchant, location, journey, tag) with short ids, a hierarchy within each kind (no loops), synonyms, merging into another tag (details asked on conflict: `detailConflicts` / `MergeConflictError`), soft delete and restore, duplicates listed; side tables `location_details` (address, coordinates, merchant, nearest-location query), `merchant_details` (default category), `journey_details` (dates; derived ones cover child journeys). The `locations` table is gone
- Short ids (12 base-62 characters) for tags, accounts and account groups; accounts reference plain tags by id (`useTagsStore`)
- Transactions: category parts as JSON (`categories`, at least one, adding up exactly to both totals), merchant / location / journey ids, plain-tag ids (`transactionRules.ts`)
- Split calculator for the form: `src/money/split.ts` (typed vs. derived parts, the spec's worked example)
- Sync: deferred FKs for self-referencing tags; `repairTags` after every merge (merge cycles, redirects, categories in use, lifts, parent loops); exact ties broken by row content, the same on every device; two-device convergence tests and sync corner-case tests (`src/sync/__tests__/cornerCases/`)

### Sync — change detection

- Which side changed a row is told by per-row base hashes, not timestamps (`src/sync/syncBase.ts`, `changeDetection.ts`); the cutoff stays as the fallback when there is no base. Decision and as-built notes: [docs/plans/2026-10-26-sync-change-detection.md](docs/plans/2026-10-26-sync-change-detection.md)

### Tags page

- Design: [docs/plans/2026-10-27-tags-page-design.md](docs/plans/2026-10-27-tags-page-design.md), plan: [docs/plans/2026-10-27-tags-page-plan.md](docs/plans/2026-10-27-tags-page-plan.md)
- `/tags` (nav item "Tags"): a tab per kind, kept in the URL (`?kind=merchant`); each a tree sorted by name with collapsible branches, a filter over every name, other names in fainter text, Add (a child) and Edit per row, duplicates outlined and explained (merged by hand), "Show deleted" with Restore. A merchant row shows its default category, a location row its merchant (not a link). Parent loops and dead parents that sync leaves show at the top level (`src/tags/tree.ts`)
- Edit dialog for every kind: name, parent (by path, never its own subtree), other names, description, colour and icon (an inherited look shows as derived, with a reset), a location's address, position ("Use my position") and merchant, a merchant's default category, a journey's dates (derived from its transactions and sub-journeys until typed). Saved in one transaction (`TagsRepository.save`): a refused rename no longer leaves a tag moved. Delete confirms with the use count; a category in use goes to merge
- Merge dialog: target of the same kind, what moves, and an answer per differing detail (keep one or type another). A merge now fills the target's empty detail with the source's link to a deleted tag
- `tags.retired_names`: removing a merged name stops it finding the tag (the merged tag's own row still holds it, and edits to a tombstone never sync); a merge carries the list on (`src/tags/otherNames.ts`)
- Plain tags can be nested now, so an account keeps its tags by id when saved and a typed name finds a tag at any level (`resolvePlainTags`)
- Rows: the linked tag (a merchant's default category, a location's merchant) sits in a chip after the name; other names and the description go on a second, fainter line
- Slim or detailed rows, chosen per device (layout setting `layout.tagRows`, a selector beside the filter): slim keeps a row to one line (the chip from sm, other names and description from md up); detailed shows everything, wrapped, plus a location's address or coordinates, radius and matching, or a journey's dates (derived ones fainter). The tags store reads every details row in one go (`TagDetailsRepository.detailsByTag`)
- A location is a circle: `location_details.radius_metres` (whole metres, 10 m by default). `nearestLocations` measures to the circle's edge, 0 inside it. The dialog edits the radius; a merge asks about a differing one
- Map picking in the location dialog: Leaflet with OpenStreetMap tiles, loaded only when the map is shown (`LocationMap.vue`). A click or a drag sets the position, the radius shows as a circle; the map opens on the location, else on its nearest placed ancestor, else the world
- Automatic matching flags, on by default: `location_details.auto_match` (off: never filled in by itself, still offered nearby; `nearestLocations` returns it flagged) and `merchant_details.auto_match` (off: imported lines naming the merchant are not matched by themselves, once import exists). A checkbox in the dialog, "not matched automatically" on a detailed row; a merge asks which flag to keep
- Map view on the Locations tab (a third option, Map, beside Slim and Detailed; layout setting `layout.locationsView`, per device): every placed location the filter lets through, as a circle of its radius in its colour (dashed when not matched automatically) with its icon at the centre; a tap or Enter on an icon opens its edit dialog; a tap on a cluster zooms in, or, when no zoom could split it, lists its locations to pick one; a count of those without a position. Fits all on first show, then keeps the view across edits and filtering. Built for 1,000 locations: circles on one canvas, icons in Leaflet.markercluster, bulk redraws (`LocationsMap.vue`, `src/tags/locationsMap.ts`); both maps share `osm.ts` (lazy Leaflet, OSM tiles, dark tiles)

### Icons

- Design: [docs/plans/2026-10-28-icons-design.md](docs/plans/2026-10-28-icons-design.md) (steps 1 and 2 built, see "As built")
- An icon is a typed JSON value in the `icon` columns of tags, accounts and groups: a pack icon, an emoji or an image; one from a newer app is kept verbatim and draws as the default icon (`src/icons/`)
- Synced `images` table (UUIDv5 of the content, rows never change; WebP, PNG where a browser cannot write WebP, or SVG), `ImagesRepository` (a word's `source` stored with sorted keys), `useImagesStore` (data URLs on demand)
- One badge for every kind (`IconBadge.vue`; `badgeElement.ts` for the map pins): rows, chips, picker options, dialogs, the Accounts page, the map and its pick list
- The icon dialog (`IconDialog.vue`, opened from the "all icons" tile of `IconPicker`; full screen on a phone) with four tabs, opening on the current icon's: Icons (every installed pack, searchable), Emoji (emoji-picker-element, loaded when the tab opens; its data bundled and precached), Text (a word in a system font, bold or not, its own text and background colours with Resets, previewed at badge sizes; `wordSvg.ts`), Image (a file: SVG cleaned with DOMPurify and kept vector, a warning over 100 KB, refused over 1 MB; raster scaled to fit 256 × 256; `upload.ts`, `svgClean.ts`, `raster.ts`)

### Archive (ideas, must-haves 1 and 2)

- Synced `tags.archived_at_utc` and `accounts.archived_at_utc` (NULL = active; `002` edited in place). `archive` / `unarchive` in `TagsRepository` and `AccountsRepository`: live rows only, stamp `updated_at_utc`, a repeat changes nothing. A sync test covers both backends and a transaction recorded offline with an archived category and account (`cornerCases/archive.spec.ts`)
- **A tag**: still live — on its transactions and accounts, in reports, found by name (typing it on an account reuses it), its names taken, a parent, a merge source or target (a merged-into tag stays archived). Not offered: `tagOptions` leaves it out (the "Under" picker, merchant and default-category pickers, the merge target), the map leaves it out, `nearestLocations` never matches it (a closed shop). A picker that already holds one shows "<name> (archived)" (`heldOption`, like "(deleted)")
- Tags page: archived tags leave the tree, except as the faint parent of active ones, marked "Archived"; "Show archived <kind> (N)" per tab lists them all, faint and marked; the filter and the map follow it ("Every merchant is archived." when nothing else is left). Edit dialog: Archive (or Unarchive) in the footer, no confirmation, closes the dialog; an archived tag's dialog says "Archived on <date>: no longer offered in pickers."
- **An account**: out of its group's block, the page and group totals and reorder mode; listed in a collapsed "Archived accounts (N)" section at the bottom with each balance and the section's own total. It keeps its group and place, so unarchiving puts it back. Account dialog: Archive / Unarchive next to Delete; one that still holds money asks first, inline ("It still holds €12.50. Archive it anyway?", from the cached balance). Store: `active`, `archived`, `archive`, `unarchive`

### Places, journeys, renames and link dropdowns (ideas: must-haves 5, 7 reworked, 8; nice-to-haves 4, 6)

- **The most specific place wins**: `nearestLocations` ranks the circles that contain the position by radius, smallest first (equal radii: the nearer centre), then the others by distance to their edge; ties by name, then id, as plain text
- **Journey currency**: synced `journey_details.currency` (NULL = inherited down the tree like the look, `src/tags/journeys.ts`; free-form code, stored upper-cased). Dialog field (inherited faint, with Reset); "in GEL" on detailed rows; a merge asks about it
- **Journey dates in one query**: `allJourneyDates` (one recursive CTE, same rules as `journeyDates`), held by the tags store. The Journeys tab sorts siblings by start, newest first, undated ones on top
- **Current journey**: the deepest live, active journey whose dates hold today (then the later start, the later end, the name), shown at the top of the Journeys tab with "Continue journey": the new-journey dialog next to it, starting today, with a note of what saving does. `TagsRepository.continueJourney` (one transaction): a top-level current journey first goes under a new parent named after its months ("Jul–Oct 2026", " (2)" when taken) with its look and currency; its end becomes today; the new journey goes beside it
- **Rename keeps the old name**: "Keep “Tinkoff” as another name", ticked unless `looksLikeTypoFix` (Damerau–Levenshtein ≤ 2 ignoring case, both names ≥ 3 characters)
- **Link dropdowns** (instead of matching a merchant's names as text): "Merchant" on the Locations tab (Any / No merchant / each), "Category" on the Merchants tab (Any / No default category / each, sub-categories included); list and map, combined with the text filter, reset per tab (`linkFilter`)
- `ChipsInput.vue`: text left typed in a chips field becomes a chip on blur and on save (the tag dialog's other names)

## To Do

### Tags and accounts — next (decided 2026-10-28, from docs/ideas/2026-10-28-tags-accounts-ideas.md)

- **Hide amounts** (nice-to-have 8): a device setting; one component draws every read-only money amount, blurred while the setting is on until tapped (until leaving the page)
- **"Show by currency" on the Accounts page** (nice-to-have 9): a temporary toggle (eye icon, not kept when leaving the page) that groups accounts by currency, cash and bank counted separately but side by side, each row keeping its group's name

### Domain model gaps

Items called out in [REQUIREMENTS.md](REQUIREMENTS.md) but not yet in the schema:

- **Named time periods** (vacations, rental stays at a specific apartment) usable as aggregation intervals: these are journeys now (journey tags with dates; data layer done, see Done)
- **Cash vs. non-cash flag** on transactions (maybe not needed yet)
- Categories, tags of five kinds and short ids: the data layer and the Tags page are done (see Done); the transaction form and reports are below
- Later: **fractional category splits** (a part given as a fraction of the transaction) and **recurring transactions** (same doc, TODO)
- Location granularity at FIAS level (location tags cover it now: a hierarchy such as country > city > store, with address and coordinates in `location_details` — FIAS-specific structure TBD) (good as is for now)

### Pinia stores over repositories

- One store per domain repository, mirroring the write-through pattern set by the layout store
    - Transactions (accounts and account groupings: done, one store — see Accounts UI; tags of every kind, locations included: `useTagsStore`, see Tags page; exchange rates: `useRatesStore` holds today's applied rates)
- Hydration on bootstrap where the working set is small enough to keep in memory
- Decide what stays repo-only vs. what gets reactive caching (transactions probably too large to fully cache)

### CRUD UI

- Accounts (list, create, edit, delete, reorder: done, see Accounts UI)
    - Optional home location picker (needs location tags first; the dialog leaves `location_id` untouched)
- Transactions
    - List with filters (by account, by date range, by tag)
    - Create — expense, income, transfer
    - Dual-currency input (account currency + purchase currency)
    - Amounts show the currency symbol where one exists (`currencySymbol`: $, €, ₽), the code otherwise; lists of accounts keep the code
    - Category picker; split across several categories, each part showing its *from* and *to* amount (remainder, rate and warning rules in the category-vs-tag decisions doc, §2.4: a negative part warns; whether the rate warning shows next to the sum warning is decided with this view's design)
    - Account pickers leave out archived accounts (`useAccountsStore().active`); an edited transaction keeps one it already has, marked "(archived)". Tag pickers already leave out archived tags (`tagOptions`, `heldOption`)
    - Merchant, location and journey fields (merchant hidden on income and transfers by default); #tag picker with autocomplete (a synonym finds the tag, the main name is shown)
    - Date/time + timezone picker; date-override field
    - Location from the device position: the nearest known location within ~150 m, nearby ones as one-tap choices, create a location from the position. A location with `auto_match` off is offered nearby but never filled in; distances count from the location's circle edge (`nearestLocations`)
    - On a journey (the device is enrolled in one): expenses and income (not transfers) are offered in the journey's currency (`journey_details.currency`, inherited down the tree)
    - Offer to join an ongoing journey (one another device started) once; after that, joining is done on the Journeys page. No automatic new journeys (ideas, nice-to-have 13)
    - Search for a place or an address on the location map (OSM Nominatim or Photon; online only) (nice-to-have 5)
    - From a tag or an account row, its transactions — through the transactions UI's own filtering UI (nice-to-have 2)
    - The time zone comes from the phone (the OS knows it); no zone per location or country
    - "On a journey" switch (per device): start a new journey or join an ongoing / recent one
    - Typed vs. derived values (the UI rule in CLAUDE.md)
    - Cash / non-cash toggle (once schema supports it)
    - Edit, soft-delete

### Exchange rates

Decided 2026-10-25 — see [docs/plans/2026-10-25-exchange-rates-decisions.md](docs/plans/2026-10-25-exchange-rates-decisions.md)
(sources checked, priorities, resolution rules, tables, the rates-repo contract).
Phases 1 and 2 (the app side) are done (see Done above). Next:

2. Rates repo — live at [xobotun/exchange-rates](https://github.com/xobotun/exchange-rates) (its README is the contract; updated twice a day; history is being backfilled one year at a time). The app reads ECB, NBG, NBK, CBA and CBR from it since 2026-10-26 (see Done). Left:
    - When a new provider or older data arrives, re-resolve the non-final `applied_rates` rows older than 8 days too (`refresh` only covers the last 8 days). Only converted totals change; stored amounts and balances do not
    - Backfill history from the year files (`v1/<bank>/years/<YYYY>/…`, one request per bank and year) instead of one day file per date, once reports or a statement import need many past dates
3. openexchangerates (App ID per device; priority 30)
4. UI for manual overrides (`setManual` / `removeManual` exist) and the review list (`applied_rates` rows with `via` set or a NULL rate)
5. Optional: Google Sheet provider; Czech / Polish central banks (direct CZK ↔ PLN)
- Transaction form (with the Transactions UI): pre-fill the second amount from the applied rate of the transaction's date (`RateService.ensure(date, …)`); the stored amounts stay the truth
- Reports: convert each transaction at its own date's applied rate (a leg already in the base currency needs no rate)
- Follow-ups from the phase-1 review (minor):
    - `isFinal` freezes a fallback row (resolved from the previous day's data) once its date is before yesterday, even when that date's own publication was never fetched — freeze only once the library holds a top-level row dated on or after it (ECB / CBA weekend rows still need a freeze)
    - The rates store loads the table only after the service's `ensure` (which may wait on the network), and one pair's failure skips the reload (`Promise.all`); load first, or in `finally`
    - Applied rates two devices resolved at different times of day (different `reference_date`) count as conflicts in Settings' sync result — don't count machine-written rows, or break ties by the fresher `reference_date`
    - A failed fetch is remembered as "nothing there" until Refresh or a reload; no `online` listener. `refreshIfStale` does not check `navigator.onLine`
    - `refresh` can fetch `latest` twice (keyed under today and yesterday) and re-fetch up to 8 dated files to re-check NULL rows; `resolveRate()` is used only by tests (the service has its own level loop)
    - `CHECK (currency_a < currency_b)` uses SQLite's UTF-8 byte order, the code JS's UTF-16 order: they differ for some pairs of exotic non-ASCII custom codes (an emoji and a U+E000–U+FFFF character)

### Aggregation & reporting

- Aggregation by:
    - Time intervals — day / month / year / custom range
    - Journeys (only the transactions tagged with the journey)
    - Categories (spending and income count only money to or from the world; transfers between own accounts are neither; a period with both expenses and income shows the net and both parts)
    - Merchants, locations
    - Tags
    - Accounts
    - Purchase currency
    - Account currency
    - Mapped base currency
    - Cash vs. non-cash
- Charts / tables for each dimension
- Cross-currency totals using exchange-rate history

### External sync — automatic flows and full UI

The backends are done (see Done above). What remains is wiring sync into
the app's automatic flows and the polished UI.

- App-launch automatic fetch populating `lastFetchedRemoteSnapshot` so
  the Settings "Last seen remote" row shows real data without a manual
  Sync now click.
- Blocking overlay during sync with a "use the local database"
  interrupt button.
- Freeze edits while a sync runs: disable every control that writes
  (buttons, forms, drag-to-reorder) and show that a sync is in progress.
  The upload exports a copy, so a later write only waits for the next
  sync, but the sync base must describe exactly the rows the upload
  exported (a few milliseconds apart today:
  docs/plans/2026-10-26-sync-change-detection.md §6). Background writers
  bypass the UI — `RateService` filling `applied_rates` — so gate writes
  in the stores, not only in the views. `syncing` in `useSyncSettings.ts`
  already tracks a running sync at module scope; move it to a store the
  views can read. Unfreeze on every exit (done, error, gave up after
  retries), and let the overlay's interrupt button end a long upload.
- Network state / metered-connection detection (PWA heuristic) and the
  auto-sync trigger policy that uses it.
- Conflict-notification email (needs a Supabase Edge Function so the
  loser of every row conflict is preserved off-device).
- See [2026-05-22-database-sync-scenarios.md](docs/scenarios/2026-05-22-database-sync-scenarios.md)

Follow-up items flagged for the next plan:
- Live verification: every backend is unit-tested against in-memory fakes
  only; none has been run against the real service yet (CORS, ETag
  exposure, rate limits). First real target: GitHub.

Known sync defects, postponed (review 2026-10-18):
- **Blob backend (Supabase/S3) can lose data on a lost race:** the blob is
  written to a fixed key *before* the sidecar compare-and-swap, so the
  loser overwrites the winner's blob (details + intended fix in
  `SqliteBlobBackend.ts`). Not an orphan-blob/GC problem.
- **Blob CAS may be ineffective:** Supabase Storage (and possibly
  Backblaze B2) may ignore `If-Match` on upload; a CORS-hidden `ETag`
  becomes `""` and every upload then fails as a CAS miss; S3's 409
  `ConditionalRequestConflict` is not treated as a CAS miss. Needs a live
  probe per provider.
- **GitHub REST path limits:** importing an older-schema remote breaks after the first
  column-adding migration; bootstrapping a repository with zero commits is
  unverified (create it with a README). Verified live on 2026-10-18
  (`npm run test:live`): `%2F` path encoding, creating a new branch in a
  non-empty repo, merge, stale CAS. Fixed then: a concurrent first sync
  (`createRef` 422) now counts as a CAS miss, and `''` in optional text
  columns is stored as NULL so it survives the CSV round trip. Browser
  CORS is still untested — needs one manual "Sync now" in the app.
  Long-term idea: sync over real git instead of the REST API.
  **Upload cost:** fixed — an upload sends only the files whose content
  changed (git blob ids computed locally and compared with the pinned
  commit; the live test checks the ids match GitHub's).
  **Device names must be unique** (the default has a random suffix; renaming
  a device to another device's name is unsupported): a device with a
  duplicate name and a smaller or empty database takes `upload-local`, which
  can drop data and leave stale trailing CSV files.
- **Clock skew:** "latest wins" compares timestamps from different devices'
  clocks. Accepted for now; concurrent edits expected to be rare. (Which side
  changed a row no longer depends on clocks: the sync base tells it, and the
  timestamp cutoff is only the fallback when there is no base — see
  docs/plans/2026-10-26-sync-change-detection.md. Exact ties are broken by
  row content, the same on every device.)
- **Same remote id, different history:** the sync base is used whenever the
  remote id and schema version match. A remote emptied and seeded again (a
  stale device's first upload into an emptied repository or bucket) or rolled
  back to an older version still matches, so rows this device did not change
  since its last upload take the remote's older copies silently. Intended fix:
  a random lineage id, written by a first upload, carried forward by every
  upload from the metadata it replaces, stored in `sync_base_info` and part
  of the match (docs/plans/2026-10-26-sync-change-detection.md, "What is
  left").


### Import

- Bank statement import (format TBD — likely CSV / OFX / institution-specific parsers)
- Push notification import (format TBD — Android notification listener export, parsing rules per bank)
- Mapping rules from raw entries to transactions, accounts, and tags
- Matching imported lines to merchants honours `merchant_details.auto_match`: a merchant with it off is not matched by itself
- Dedup against existing transactions (a statement line that matches a hand-entered transaction fills that transaction's `description__auto` instead of adding a second one)
- Later: **live balances and transactions from banks (open banking)** — automatic ingest of transactions too; needs a licensed aggregator and per-country coverage (ideas, group 3 item 9)
- Later: **scanning receipts**, and **reading them (OCR) with each item sorted into a category**, which splits the transaction by category

### Later (decided 2026-10-28, from docs/ideas/2026-10-28-tags-accounts-ideas.md)

- **Check a balance against the bank, and correct it** (ideas, must-have 4): type what the bank shows, record a correction for the difference; also gives opening balances without counting them as income (needs a category kind that reports leave out)
- **Probable duplicates** (must-have 6): same names after folding case, accents and punctuation at any level, nearby locations with similar names. Wait for real data
- **Forgiving search** (must-have 9): ignore accents and punctuation; also match addresses and descriptions
- **Usage counts and "last used" per tag** (nice-to-have 1): beware false positives — a trip two years ago with another planned does not make its merchants obsolete
- **Select several tags: merge, move or archive at once** (nice-to-have 3): low priority
- **Category from the place and from history** (nice-to-have 7): after real data
- **Small Tags page comforts** (nice-to-have 15): "Add 'Kaufland'" from a filter with no match, collapsed branches kept per device, Collapse all / Expand all, …
- **Starter categories** (nice-to-have 14): migration 003 with deterministic ids, once Pavel and his wife agree the list
- **Undo a merge, right after it** (ideas, group 3 item 4, narrowed): after a merge the page offers Undo while the user has not left it or touched either tag. Save the rows the merge changes (both tags, their details, the rewritten references) before it, and put them back in one transaction, only while nothing has changed them since (a sync in between turns Undo off)
- **Location shapes instead of circles** (ideas, group 3 item 6): an airport, a mall, a long market street. Unlikely soon: drawing and editing a polygon on a phone is the hard part, plus point-in-polygon matching and syncing the shape
- **Budgets** per journey or category (ideas, group 3 item 8): later, a feature of its own (periods, rollover, alerts)

### Polish & operational gaps

- Replace placeholder pages (Page Two, About) with real content or remove them
- Real PWA icons (current 192/512 PNGs are placeholders)
- App branding — name, theme, favicon
- First-run onboarding (prompt to create the first account)
- Expose `.sqlite` export/import in the UI — the capability exists as `sqliteBlobCodec` (`exportDatabaseToBlob` / `openDatabaseFromBlob`, `VACUUM INTO` + MemoryVFS); needs a settings affordance
- Rewrite the stale e2e spec (still asserts the create-vue "You did it!" heading) — e.g. change a setting, reload, setting persists — and run it in CI
- PWA update UX: `registerType: 'prompt'` with no prompt UI, so a new version waits until every tab is closed
- Split the 540-line `SettingsView.vue` into sections + a provider-block component; accessibility of the new sync sections (radio group, three identical "Validate" buttons, results not announced)
- Settings writes to localStorage (quota exceeded / blocked storage) still throw to the click handler instead of showing an error

### Known defects / open decisions

- `accounts.balance_*` is a cache now (see "Account balances" under Done); the currency column is still named `currency` rather than `balance_currency`
- A sync conflict on an `accounts` row (edited on two devices) captures both sides' cached balance in its snapshot; the two may differ for no data reason. Cosmetic — matters only once a conflict viewer exists (strip `DERIVED_COLUMNS` from the snapshots then)
- Settings persistence for items still living only in `useLayoutStore` defaults (e.g., `isTemporarilyToggled` resets on refresh — intentional, document if it stays that way)
- Tags page: an edit dialog keeps the other names it read when it opened, so a save after a sync merged more names into the tag (another tab, or auto-sync once it exists) retires those as removed. Re-read the carried names on save, or freeze edits while a sync runs (see External sync)
- Tags page: the tabs have no tab panels, so each tab's `aria-controls` points nowhere
- Current journey: a journey with no typed end counts as ended on its last transaction's date (its derived end), so one under way whose last purchase was yesterday is not current this morning. Decide whether an untyped end should count as open while the start is typed
