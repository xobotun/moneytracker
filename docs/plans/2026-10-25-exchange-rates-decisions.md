# Exchange Rates — Decisions

**Status:** Decisions agreed 2026-10-25 in a brainstorming session. Phase 1
(below) built 2026-10-25 on branch `exchange-rates`; it replaced the
placeholder rules in `src/money/rates.ts`. Phase 2 on the app side (reading
the central banks from the rates repo) built 2026-10-26.

**Goal:** Convert amounts between currencies for display, reports and the
transaction form, using authoritative rates where they exist, working
offline, and telling the user which currency pairs lack a direct rate so a
better source can be added.

---

## What rates are for

1. **Current values** — account balances and group / page totals in the base
   currency (Accounts page, already built on the placeholder).
2. **History** — reports in the base currency need the rate on each
   transaction's date (REQUIREMENTS: "map any currency used across the entire
   history").
3. **The transaction form** — suggests the market rate of the transaction's
   day for the second amount. The user overwrites it with what was actually
   charged (paying 4000 AMD with a EUR Revolut card rarely matches the
   market rate).

Converted amounts stay approximations for display; they are never stored and
never added to an account's money. Only *rates* are stored.

## Sources

Facts checked on 2026-10-25 (curl and a real Chrome page on the dev server).
"CORS" = whether a script on another origin may read the response, which a
static GitHub Pages app needs.

| Source | Access | CORS | History | Coverage | Notes |
|---|---|---|---|---|---|
| **ECB** via Frankfurter (`api.frankfurter.dev/v1`) | JSON, no key | yes | from 1999-01-04 | 30 currencies (CZK, PLN, HUF, CHF, GBP, USD, SEK, NOK, DKK, RON, TRY…); no RUB, KZT, AMD, AED, GEL, crypto | Base EUR. Working days only (no weekend / holiday rows). A date range is one request (all of 2025 = 105 KB). |
| **NBG** Georgia (`nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/?date=`) | JSON, no key | yes | at least from 2010 | 43 currencies incl. KZT, AMD, RUB, AED, EUR, USD, CZK, PLN | Base GEL. Every calendar day until 2021; since then nothing for Sundays and Mondays (a request returns Saturday's rates, dated Saturday). Rates are per `quantity` (GEL per 100 KZT, per 1000 AMD). One request per date. |
| **NBK** Kazakhstan, Excel export (`nationalbank.kz/en/exchangerates/ezhednevnye-oficialnye-rynochnye-kursy-valyut/excel?beginDate=&endDate=&rates[]=`) | `.xlsx`, no key; the `_token` parameter is not needed | **no** | 2020 checked | AMD, GEL, RUB, EUR, USD, CZK… (about 48 in the form) | Base KZT. Every calendar day. Whole range in one request (2020→today EUR = 44 KB, 2,491 rows). Currencies are internal ids (`rates[]=6` is EUR). The RSS XML feed (`/rss/get_rates.cfm?fdate=`) has no CORS either, and answers any date — even a future one — with the newest rates, so fetchers never ask past today. |
| **CBA** Armenia, CSV export (`cba.am/en/exchange-rates-archive/export?currencies[]=KZT&date-from=DD/MM/YYYY&date-to=`) | CSV, no key; `as_sfid` / `as_fid` not needed | **no** | 2020 checked | KZT, GEL, RUB, EUR, USD, gold, ~60 | Base AMD. Working days only. Whole range in one request for a few codes (KZT+GEL+EUR 2020→today = 66 KB); with all ~50 codes a multi-year export times out after ~65 s, so ask one year at a time. Gold and silver are quoted per gram. Header carries the unit (`"KZT 10"`). The SOAP API (`api.cba.am/exchangerates.asmx`) has no CORS and its GET binding answers 500. |
| **CBR** Russia (`cbr.ru/scripts/XML_daily.asp`) | XML, windows-1251 | **no** | 2020 checked | AMD, KZT, EUR, USD; GEL only in recent years (not in 2020) | Rates run Tuesday to Saturday; the XML's `Date` is when they apply from. Unofficial mirror `cbr-xml-daily.ru` serves JSON with CORS. In the rates repo. |
| **fawazahmed0** (`cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date|latest}/v1/currencies/{code}.json`, mirror `{date}.currency-api.pages.dev`) | JSON, no key, no limits | yes | from **2024-03-02** | ~340 codes incl. crypto and metals (and junk coins); the set changes over time | Daily; `latest` lags a day. Lowercase codes. No accuracy / uptime promise. Sources are hidden in CI secrets (`currscript.js`): an EUR-based fiat API, a USD feed scraped with headless Firefox, CoinMarketCap-shaped crypto. Every file is derived from one EUR set, so only the EUR file counts as direct; other bases are crosses through EUR. |
| **openexchangerates.org** | JSON, App ID | yes | from 1999 | ~170 + alternatives | Free plan: USD base only, 1,000 requests / month, one request per historical day; hourly updates. |
| Google Sheets `GOOGLEFINANCE` | public sheet read via `/gviz/tq?tqx=out:csv` | yes | **current values only** | Google Finance pairs (KZT / AMD support not verified) | Historical values read outside Sheets return `#N/A` (since 2016). A daily Apps Script copying values into a log tab builds history forward only. Not chosen; possible later "bring your own rates" adapter. |

Candidates for later: the Czech (CNB) and Polish (NBP) central banks, for a
direct CZK ↔ PLN rate. Their feeds have not been checked.

## Decisions

### Providers and priority

- Every provider is an object in code with a **`priority`** number that sets
  the order they are queried in. Providers with the same number form one
  **level**.
- Levels, highest first:
  1. **`manual`** — the user's overrides. A provider like the others.
  2. **Central banks** — ECB, NBG, NBK, CBA (and any added later), one level.
  3. **fawazahmed0**.
  4. **openexchangerates**.
- **All central banks come from a separate git repo** (the "rates repo"): a
  scheduled GitHub Action curls each bank and commits the data. The app reads
  its files from `raw.githubusercontent.com` (CORS `*`, checked). This is the
  only way to reach NBK and CBA from a browser; ECB and NBG, though
  reachable directly, go through the repo too, so the repo is one convenient
  public source for everyone. Its contract is below.

### Resolving a rate

For a currency pair on a date:

1. Look in `applied_rates` (below), which also holds the manual overrides.
   Found → done; no other lookups.
2. Otherwise go through the levels in priority order. At each level, look in
   the local `exchange_rates` first, then fetch from that level's sources:
   1. a **direct** rate from any provider of the level — a row whose base is
      one currency of the pair and that lists the other. Either direction
      counts: NBK's "KZT per EUR" serves EUR → KZT and KZT → EUR;
   2. else a **cross** rate through **one** intermediate currency, from that
      level's data. The two legs may come from different providers of the
      level (e.g. ECB's EUR/CZK with NBK's KZT/EUR);
   3. else the next level.
3. The **first level that answers wins**, even if a lower level has a direct
   rate. Example: CZK → PLN uses the ECB cross through EUR, not fawazahmed0's
   "direct" CZK file (which is itself a cross through EUR).
4. The result is written to `applied_rates`. A cross result keeps its
   intermediate currency (`via`); nothing found anywhere is written with
   `rate = NULL`. Both are the **review list**: pairs that lack a direct
   rate, so the user can add a source (e.g. the Polish / Czech banks for
   CZK → PLN).
5. **Which date:** the newest rate on or before the date, up to **7 days**
   back (weekends and holidays have no ECB / CBA rows).
6. **Transaction date:** the date the transaction happened, not its date
   override (the money changed hands on the real date; the override only
   files it into a reporting period).
7. **The display never waits on the network.** It shows what the database
   has, fetches what is missing in the background, and updates.

### Tables

**`exchange_rates` — the reference library. Device-local; does not sync.**

- Shape unchanged: one row per (date, base currency, provider), every
  currency of that publication in the `rates` JSON object, exactly as the
  source publishes it. Central banks' data lands here too (providers `ecb`,
  `nbg`, `nbk`, `cba`, …).
- Its job is offline availability. Everything in it can be downloaded again
  from the rates repo and fawazahmed0, so it leaves `SYNC_TABLES` /
  `SYNC_COLUMNS` and the sync volume stays small.
- The SQLite-blob backends upload the whole database file, so there the
  library still rides along (never merged). Accepted for now; revisit if it
  slows sync down.

**`applied_rates` — the rate the app uses for a day and a pair. Syncs.**

- One row per **(date, currency A, currency B)**:
  - **A < B alphabetically**; `rate` is how much B one A buys; the other
    direction is `1 / rate`. KZT → AMD and AMD → KZT share the row.
  - The id is a UUIDv5 of that key, like `exchange_rates` today, so two
    devices that create the same row merge it as one.
- **An override is the same row with `provider = 'manual'`**, and **manual
  always wins a sync conflict**: when both devices changed the row since
  their last sync and exactly one side is manual, the manual side wins
  whatever the timestamps; two manual sides → the newest wins as usual. A
  table-specific rule in `resolveConflict`, applied after "delete wins".
  Without it, a device that auto-filled the same day after the override was
  set would win on the newer timestamp and silently drop the override.
  Built as a rank (`ROW_RANK`): manual > direct > cross > none found, so a
  found rate is not lost to an empty row from an offline device either.
- **Rows two devices compute alike are no conflict.** Two devices resolving
  the same rate write identical rows at different moments; the merge
  comparison and the database hash skip `applied_rates` timestamps
  (`EQUALITY_IGNORED_COLUMNS`).
  - Removing an override turns the row back into an auto row (resolved
    again, `rate` NULL until then).
  - An override edited on one device while removed on another (both before
    syncing) keeps the edit — both are deliberate.
- Columns (beyond the key and the sync columns):
  - `rate` — REAL; NULL = nothing found;
  - `provider` — `manual` or the provider the rate came from (both legs'
    providers for a cross from two banks); NULL = nothing found;
  - `via` — the intermediate currency of a cross rate; NULL = direct;
  - `reference_date` — the day the data actually comes from (Friday's ECB
    rate used on a Sunday; the older leg of a cross); NULL = nothing found.
    Tells a fallback from an exact hit when deciding whether a row is final.
- Example: `2026-10-20 | AMD | KZT | 1.256 | cba | via NULL | 2026-10-20`.
- Review list = `via IS NOT NULL OR rate IS NULL`.

### Keeping applied rates current

- An auto row is **final** only when it is a direct rate from the top
  non-manual level for its date. Non-final rows are resolved again when new
  reference data for that date arrives (the nightly rates-repo run, a newly
  added bank). Today's rows are resolved again the next day (fawazahmed0
  lags a day; the ECB publishes in the afternoon).
- A new resolution only replaces a row with a better one (higher level,
  direct over cross); it never downgrades, and never touches a manual row.
  This also keeps devices from ping-ponging a row through sync — within one
  level. Across two levels the sync rank (`ROW_RANK`) does not follow the
  level yet; that is to be fixed before phase 2 adds the bank level (see
  TASKS.md).
- Review-list rows are re-checked about once a day.
- An improved rate changes only converted totals: the stored amounts of
  transactions and the account balances never depend on rates.

### Refresh

- On app start, when the newest rate is older than yesterday and the device
  is online; a "Refresh rates" button; lazy backfill when a lookup misses.
- Never inside `db.transaction` (no network work while holding the lock).

### Transactions

- **The stored amounts are the truth.** Converting a transaction to the base
  currency: if either side is in the base currency, that side *is* the base
  amount (no rate). Otherwise the account side is converted at that day's
  applied rate.
- **The transaction form pre-fills** the second amount from the applied rate
  of the transaction's date; the user overwrites it with the real charge.
  Optional extra: show the effective rate and its gap to the market rate
  ("+1.8% over market"). The transactions UI is its own task; this work only
  provides the lookup it uses.

## Rates repo contract (v1)

The repo is live at https://github.com/xobotun/exchange-rates, and its
README is the authoritative description of the published files; this
section is the summary the app relies on. It mirrors fawazahmed0's layout
and file shape, so one parser serves both (`src/money/providers/rateFile.ts`).

- **Public GitHub repo**, read by the app at
  `https://raw.githubusercontent.com/xobotun/exchange-rates/main/` (CORS `*`, a
  5-minute cache). Everything below lives under `v1/`; a breaking change
  goes to `v2/`.
- **One provider per bank**, named by a short id: `ecb`, `nbg`, `nbk`, `cba`,
  `cbr` (later perhaps `cnb`, `nbp`). Each publishes in its **home currency**
  as the base: `ecb` → `eur`, `nbg` → `gel`, `nbk` → `kzt`, `cba` → `amd`,
  `cbr` → `rub`.
- **Day files**, exactly fawazahmed0's
  `currency-api@{date}/v1/currencies/{code}.json`:
  - `v1/<provider>/<YYYY-MM-DD>/currencies/<home>.json`
  - `v1/<provider>/latest/currencies/<home>.json`
  - Body: `{"date": "YYYY-MM-DD", "<home>": {"<code>": <number>, …}}` —
    lowercase codes; the number is how many units of `<code>` **one** unit
    of `<home>` buys. Banks that quote per 10 / 100 / 1000 units are divided
    down; banks that quote "home per foreign" (NBK, CBA, NBG) are inverted
    (`1 / quote`, full double precision, no rounding). Metals (`xau`, `xag`)
    are per **troy ounce**, as ISO 4217 means them; CBA's per-gram quotes
    are converted.
  - `date` in the body is the **publication** the rates come from. There is
    a file for **every calendar day**: on a day the bank does not publish
    (weekends, holidays) it repeats the newest earlier publication with that
    publication's `date`. One request per day always answers, and the app
    stores the body's `date` as the `reference_date`.
- **Year files** for backfill in one request:
  `v1/<provider>/years/<YYYY>/currencies/<home>.json` →
  `{"year": "2025", "<home>": {"2025-01-02": {"<code>": <number>, …}, …}}`,
  publication days only.
- **Metadata:**
  - `v1/providers.json` — `["ecb", "nbg", "nbk", "cba", "cbr"]`;
  - `v1/<provider>/meta.json` — `{"provider": "nbk", "name": "National Bank
    of Kazakhstan", "home": "kzt", "source": "<url>", "first_date":
    "2019-12-24", "last_date": "2026-10-25"}`: the span the tree actually
    holds. The app skips dates before `first_date`. (No `publishes` field:
    banks keep their own calendars — the Georgian bank publishes nothing for
    Sundays and Mondays since 2021, the Russian bank's rates run Tuesday to
    Saturday — and the app needs none of it, since every day has a file.)
- **History starts on 2019-12-24** for every bank, a week before the
  user's data, so the app's 7-day lookback from 2020-01-01 always finds a
  publication inside the year files.
- **Raw downloads** are kept for auditing under `raw/<provider>/<YYYY>/…`, as
  the bank served them. The app never reads them.
- **Updates:** a scheduled GitHub Action twice a day (06:00 and 18:00 UTC),
  plus a manual backfill workflow, one calendar year per run. A
  failed fetch leaves the files untouched: never partial or empty files.
  Commits only when data changed.
- **Only real codes:** ISO 4217 and the metals or crypto a bank actually
  quotes; nothing invented.

## Phases

1. Rate resolution and `applied_rates` (with the manual-wins sync rule);
   `exchange_rates` becomes device-local; providers with priorities; the
   fawazahmed0 fetcher; refresh. Replaces the placeholder `RateTable`.
2. The rates repo (above) with ECB, NBG, NBK, CBA and CBR, and the app's
   provider reading it (one provider per bank, all on the central-bank
   level). Built 2026-10-26; the sync rank now follows the levels too
   (`src/money/levels.ts`).
3. openexchangerates (App ID stored per device, like sync credentials).
4. UI for overrides and the review list.
5. Optional: Google Sheet provider; CNB / NBP.
