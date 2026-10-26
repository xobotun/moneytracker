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
    - `locations`
    - `tags` (natural string PK)
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
  like BTC allowed), icon (quick picks + a searchable popover with every
  PrimeIcons icon), colour (presets + custom), free-form tags. New accounts
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

## To Do

### Sync: tell which side changed a row without timestamps

Known bug, postponed 2026-10-26. A change made offline and uploaded after another device's
last sync counts as "unchanged" on that device, so delete-wins and rank rules are skipped and
the discarded change is not reported: a delete or a manual exchange rate is lost on both
devices, even with synchronised clocks. Problem, why the current mechanisms miss it, options
with their upsides and downsides, and the recommendation (per-row base hashes):
[docs/plans/2026-10-26-sync-change-detection.md](docs/plans/2026-10-26-sync-change-detection.md).

- Deliberately failing tests until this is done: the two `it.fails` in
  `src/sync/__tests__/cornerCases/cutoff.spec.ts` — turn them into `it(...)` when fixed
- Revisit `src/sync/__tests__/convergence.spec.ts` "after a redirect whose merged tag comes
  back", which relies on today's cutoff

### Domain model gaps

Items called out in [REQUIREMENTS.md](REQUIREMENTS.md) but not yet in the schema:

- **Named time periods** (vacations, rental stays at a specific apartment) usable as aggregation intervals: these are journeys now, part of the tags refactor below
- **Cash vs. non-cash flag** on transactions (maybe not needed yet)
- **Categories** on transactions: at least one per transaction, splittable across several with a *from* and a *to* amount per part. Decided 2026-10-26, see [docs/plans/2026-10-26-category-vs-tag-decisions.md](docs/plans/2026-10-26-category-vs-tag-decisions.md); the tables are not designed yet
- **Tags refactor** (decided 2026-10-26, same doc; tables not designed yet): one `tags` table with a `kind` (category, merchant, location, journey, tag) and short ids; a hierarchy within each kind (no loops, also after sync); synonyms as extra names and merging (with a redirect for devices that sync later); a soft delete that hides a tag but keeps its references. The `locations` table becomes location tags plus a side table (address, coordinates, merchant); merchants get a default category; journeys get start and end dates and a per-device "on a journey" switch
- **Short ids** for tags, accounts and account groups: 12 random base-62 characters instead of UUIDv7, since they are created rarely and referenced often. Touches the schema (migration 002 edited in place), `src/db/uuid.ts` (a generator and branded type next to `newId`), `types.ts`, `columnMappers.ts`, the repositories, `src/stores/accounts.ts`, `AccountsView.vue`, the sync descriptors, and the primary-key convention in CLAUDE.md
- Later: **fractional category splits** (a part given as a fraction of the transaction) and **recurring transactions** (same doc, TODO)
- Location granularity at FIAS level (current `locations` table covers country/city/lat/lon/address — FIAS-specific structure TBD) (good as is for now)

### Pinia stores over repositories

- One store per domain repository, mirroring the write-through pattern set by the layout store
    - Transactions, tags, locations (accounts and account groupings: done, one store — see Accounts UI; exchange rates: `useRatesStore` holds today's applied rates)
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
    - Category picker; split across several categories, each part showing its *from* and *to* amount (remainder, rate and warning rules in the category-vs-tag decisions doc)
    - Merchant, location and journey fields (merchant hidden on income and transfers by default); #tag picker with autocomplete (a synonym finds the tag, the main name is shown)
    - Date/time + timezone picker; date-override field
    - Location from the device position: the nearest known location within ~150 m, nearby ones as one-tap choices, create a location from the position
    - "On a journey" switch (per device): start a new journey or join an ongoing / recent one
    - Typed vs. derived values (the UI rule in CLAUDE.md)
    - Cash / non-cash toggle (once schema supports it)
    - Edit, soft-delete
- Tags page (all kinds, a tree per kind): create, rename, move, merge into another tag (its name becomes a synonym), soft-delete; duplicates (same kind, parent and name) highlighted; locations also edit their address, coordinates and merchant, merchants their default category, journeys their dates

### Exchange rates

Decided 2026-10-25 — see [docs/plans/2026-10-25-exchange-rates-decisions.md](docs/plans/2026-10-25-exchange-rates-decisions.md)
(sources checked, priorities, resolution rules, tables, the rates-repo contract).
Phases 1 and 2 (the app side) are done (see Done above). Next:

2. Rates repo — live at [xobotun/exchange-rates](https://github.com/xobotun/exchange-rates) (its README is the contract; updated twice a day; history is being backfilled one year at a time). The app reads ECB, NBG, NBK, CBA and CBR from it since 2026-10-26 (see Done). Left:
    - When a new provider or older data arrives, re-resolve the non-final `applied_rates` rows older than 8 days too (`refresh` only covers the last 8 days)
    - Backfill history from the year files (`v1/<bank>/years/<YYYY>/…`, one request per bank and year) instead of one day file per date, once reports or a statement import need many past dates
3. openexchangerates (App ID per device; priority 30)
4. UI for manual overrides (`setManual` / `removeManual` exist) and the review list (`applied_rates` rows with `via` set or a NULL rate)
5. Optional: Google Sheet provider; Czech / Polish central banks (direct CZK ↔ PLN)
- Transaction form (with the Transactions UI): pre-fill the second amount from the applied rate of the transaction's date (`RateService.ensure(date, …)`); the stored amounts stay the truth
- Reports: convert each transaction at its own date's applied rate (a leg already in the base currency needs no rate)
- Follow-ups from the phase-1 review (minor):
    - `isFinal` freezes a fallback row (resolved from the previous day's data) once its date is before yesterday, even when that date's own publication was never fetched — freeze only once the library holds a top-level row dated on or after it (ECB / CBA weekend rows still need a freeze)
    - The rates store loads the table only after the service's `ensure` (which may wait on the network), and one pair's failure skips the reload (`Promise.all`); load first, or in `finally`
    - Settings' conflict text ("deletions win, otherwise the latest edit wins") omits `rank-wins`; applied rates two devices resolved at different times of day (different `reference_date`) count as conflicts — don't count machine-written rows, or break ties by the fresher `reference_date`
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
- Network state / metered-connection detection (PWA heuristic) and the
  auto-sync trigger policy that uses it.
- Conflict-notification email (needs a Supabase Edge Function so the
  loser of every row conflict is preserved off-device).
- See [2026-05-22-database-sync-scenarios.md](docs/scenarios/2026-05-22-database-sync-scenarios.md)

Follow-up items flagged for the next plan:
- Real schema migration in `useSyncSettings.syncNow` — currently a
  plan-mandated stub that throws. Real cross-schema migration on
  downloaded remote DBs is deferred.
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
- **Clock skew / ties:** the merge cutoff compares timestamps from
  different devices' clocks, and equal timestamps resolve to the local side
  (two devices can flip-flop). Accepted for now; concurrent edits expected
  to be rare.


### Import

- Bank statement import (format TBD — likely CSV / OFX / institution-specific parsers)
- Push notification import (format TBD — Android notification listener export, parsing rules per bank)
- Mapping rules from raw entries to transactions, accounts, and tags
- Dedup against existing transactions (a statement line that matches a hand-entered transaction fills that transaction's `description__auto` instead of adding a second one)

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

- A soft-deleted tag cannot be re-created (the tag name is the primary key); with sync, delete-wins also removes a tag re-created offline. Goes away with tag ids (tags refactor)
- `accounts.balance_*` is a cache now (see "Account balances" under Done); the currency column is still named `currency` rather than `balance_currency`
- A sync conflict on an `accounts` row (edited on two devices) captures both sides' cached balance in its snapshot; the two may differ for no data reason. Cosmetic — matters only once a conflict viewer exists (strip `DERIVED_COLUMNS` from the snapshots then)
- Settings persistence for items still living only in `useLayoutStore` defaults (e.g., `isTemporarilyToggled` resets on refresh — intentional, document if it stays that way)
