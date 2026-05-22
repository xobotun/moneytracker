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
- ESLint + Prettier
- Vitest + Vue Test Utils
- Playwright e2e scaffold
- GitHub Actions: lint + unit tests on PR
- GitHub Pages deploy on merge to `main`
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
- COOP/COEP headers: `coi-serviceworker` for GitHub Pages, Vite dev middleware for local
- `Database` class — `init`, `exec`, `run`, `close`, `isOpen`
- Versioned migration runner backed by a `migrations` table
- `001_settings` migration + `SettingsRepository`
- Layout store rewritten as write-through cache; hydrates from SQLite on bootstrap; persists across reloads
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
    - `exchange_rates` (per-provider rows; no unique on date+base)
    - `account_groupings` (members stored as JSON array of account UUIDs)
    - `transactions` — double-entry, nullable from/to legs for "Global Economy" income/spend
- Sync columns on every domain table: `created_at_utc`, `updated_at_utc`, `deleted_at_utc`
- Soft-delete pattern; repos filter out deleted rows by default
- Repositories for all six entities (create / find / list / update / softDelete + entity-specific queries)
- Repositories wired into `src/db/init.ts`
- SQLite conventions promoted into [CLAUDE.md](CLAUDE.md)
- Plan: [2026-05-20-database-schema-plan](docs/plans/2026-05-20-database-schema-plan.md)

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
    - Accounts, transactions, tags, locations, exchange rates, account groupings
- Hydration on bootstrap where the working set is small enough to keep in memory
- Decide what stays repo-only vs. what gets reactive caching (transactions probably too large to fully cache)

### CRUD UI

- Accounts
    - List, create, edit, soft-delete
    - Currency, starting balance, colour, icon, optional home location, tags
- Transactions
    - List with filters (by account, by date range, by tag)
    - Create — expense, income, transfer
    - Dual-currency input (account currency + purchase currency)
    - Tag picker with autocomplete (resolve synonyms)
    - Date/time + timezone picker; date-override field
    - Location picker (existing location, lat/lon pin, or free-form)
    - Cash / non-cash toggle (once schema supports it)
    - Edit, soft-delete
- Tags — list, create, edit synonyms, soft-delete
- Locations — list, create, edit, soft-delete
- Account groupings — list, create, edit member accounts, soft-delete

### Exchange rates

- Fetcher pulling from openexchangerates and fawazahmed0
- Upsert into `exchange_rates` with the correct `provider` tag
- Refresh strategy — on app start, on demand, scheduled background
- UI for browsing rates and overriding specific (date, base, target) entries
- User picks a base currency for reporting (USD / EUR / custom)

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

### External sync

- It is still yet to choose the sync provider. Shortlist is Supabase, Backblaze, and Github. Also, Google Drive sounds good as a backup place.
- Design an abstraction layer for the sync provider, support operations:
  - Get a blob of the latest `.sqlite`
  - Get its hash and modification date that is stored separately
  - Upload a new `.sqlite` blob and its hash and modification date
- See [2026-05-22-database-sync-scenarios.md](docs/scenarios/2026-05-22-database-sync-scenarios.md)

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
- Expose `.sqlite` export/import in the UI — capability exists at the `Database` layer via `VACUUM INTO` + MemoryVFS; needs a settings affordance
- Settings persistence for items still living only in `useLayoutStore` defaults (e.g., `isTemporarilyToggled` resets on refresh — intentional, document if it stays that way)
