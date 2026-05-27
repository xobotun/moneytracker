# Requirements

## Core Data Model

### Accounts
- Track multiple accounts across different banks/ecosystems.

### Transactions
- Three transaction types: **expense**, **income**, **transfer** (between accounts).
- Each transaction has:
  - **Account currency amount** — what was debited/credited on the account.
  - **Purchase currency amount** — the actual currency of the purchase (e.g., spent 1200 KZT but it was really 900 AMD).
  - **Category** and **tags** with descriptions.
  - **Datetime + timezone + location** (country/city/geoposition, FIAS-level granularity). Specific venues via tags.
  - **Date override** — logical date can differ from transaction date (e.g., tickets bought in December for a January trip).
  - **Cash vs. non-cash** flag (for aggregation).

### Currency & Exchange Rates
- Store exchange rate history.
- Map any currency used across the entire history to a user-chosen base currency (USD/EUR/etc.).

### Tags
- Tags support **synonyms**: `#wildberries` == `#wb`.

### Time Periods
- Named time periods (e.g., vacations, rental stays at a specific apartment) that span date ranges.
- Usable as aggregation intervals.

## Aggregation & Reporting
- Aggregate by: time intervals (day/month/year/custom periods), tags, accounts, purchase currency, account currency, mapped base currency, cash vs. non-cash.

## Import
- Import bank statements (format TBD).
- Import push notifications (format TBD).

## Sync
- Offline-first: the app works fully standalone; sync is opportunistic when online.
- Multi-device: any number of user devices share one logical database via a chosen cloud target.
- Pluggable sync provider — at minimum Supabase, S3-compatible (Backblaze B2 / Cloudflare R2), and GitHub repository as candidates. One is active at a time; credentials for all three are persisted so switching is friction-free. (See [docs/scenarios/2026-05-22-database-sync-scenarios.md](docs/scenarios/2026-05-22-database-sync-scenarios.md).)
- Each device has a user-editable name used as its identity in sync metadata; defaults to a UA-derived name with a random 8-char suffix to keep un-renamed devices distinguishable.
- Settings exposes sync status as read-only data: last sync (timestamp, uploader, hash), current local-database hash, and the last cached remote snapshot. Opening Settings never triggers a network call. (See [docs/plans/2026-05-27-sync-settings-design.md](docs/plans/2026-05-27-sync-settings-design.md).)
- Settings exposes per-provider credential fields. Stored plaintext in localStorage — the realistic threat model (XSS) already loses the whole SQLite database, so at-rest encryption of tokens gains nothing meaningful.
