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
- Not yet used: account balances and group totals in the base currency are
  next (where to keep a running balance is still open)

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
- An account that transactions use cannot change its currency

---

## To Do

### Domain model gaps

Items called out in [REQUIREMENTS.md](REQUIREMENTS.md) but not yet in the schema:

- **Named time periods** (vacations, rental stays at a specific apartment) usable as aggregation intervals (Will be done later in the next iterations)
- **Cash vs. non-cash flag** on transactions (maybe not needed yet)
- **Category field** on transactions (REQUIREMENTS treats category and tags as distinct concepts; current schema only has tags) (decided to go with tags for now)
- Location granularity at FIAS level (current `locations` table covers country/city/lat/lon/address — FIAS-specific structure TBD) (good as is for now)

### Pinia stores over repositories

- One store per domain repository, mirroring the write-through pattern set by the layout store
    - Transactions, tags, locations, exchange rates (accounts and account groupings: done, one store — see Accounts UI)
- Hydration on bootstrap where the working set is small enough to keep in memory
- Decide what stays repo-only vs. what gets reactive caching (transactions probably too large to fully cache)

### CRUD UI

- Accounts (list, create, edit, delete, reorder: done, see Accounts UI)
    - Optional home location picker (needs the Locations UI first; the dialog leaves `location_id` untouched)
    - Show a balance once `accounts.balance_*` semantics are decided
- Transactions
    - List with filters (by account, by date range, by tag)
    - Create — expense, income, transfer
    - Dual-currency input (account currency + purchase currency)
    - Amounts show the currency symbol where one exists (`currencySymbol`: $, €, ₽), the code otherwise; lists of accounts keep the code
    - Tag picker with autocomplete (resolve synonyms)
    - Date/time + timezone picker; date-override field
    - Location picker (existing location, lat/lon pin, or free-form)
    - Cash / non-cash toggle (once schema supports it)
    - Edit, soft-delete
- Tags — list, create, edit synonyms, soft-delete
- Locations — list, create, edit, soft-delete

### Exchange rates

- Fetcher pulling from openexchangerates and fawazahmed0
- Upsert into `exchange_rates` with the correct `provider` tag (`create` rejects an existing (date, base, provider) key, so the fetcher must update the existing row)
- Refresh strategy — on app start, on demand, scheduled background
- UI for browsing rates and overriding specific (date, base, target) entries

### Aggregation & reporting

- Aggregation by:
    - Time intervals — day / month / year / custom range
    - Named time periods (once they exist)
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
- Dedup against existing transactions

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

- A soft-deleted tag cannot be re-created (the tag name is the primary key); with sync, delete-wins also removes a tag re-created offline
- `accounts.balance_*` is a cache now (see "Account balances" under Done); the currency column is still named `currency` rather than `balance_currency`
- Settings persistence for items still living only in `useLayoutStore` defaults (e.g., `isTemporarilyToggled` resets on refresh — intentional, document if it stays that way)
