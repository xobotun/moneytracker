# Requirements

## Core Data Model

### Accounts
- Track multiple accounts across different banks/ecosystems.
- A new account starts at a zero balance; money already on it is entered as an **income** transaction (there is no separate starting-balance field).
- An account is either **cash** (money in hand, like a wallet) or not; this is what reports split cash from non-cash by. An ATM withdrawal is a transfer into a cash account.

### Transactions
- Three kinds of transaction: **expense** (account → world), **income** (world → account), **transfer** (between accounts). There is no type field: the kind follows from which sides are accounts.
- Each transaction has:
  - **Account currency amount** — what was debited/credited on the account.
  - **Purchase currency amount** — the actual currency of the purchase (e.g., spent 1200 KZT but it was really 900 AMD).
  - **Categories** (at least one, see Categories) and **tags** with descriptions.
  - **Datetime + timezone + location** (country/city/geoposition, FIAS-level granularity). Specific venues via tags.
  - **Date override** — logical date can differ from transaction date (e.g., tickets bought in December for a January trip).
  - **Description** — the user's own note, and separately what an import read (OCR, bank API, bank statement, …), kept as JSON.
  - **Cash vs. non-cash** — taken from the account (see Accounts), not stored per transaction.

### Currency & Exchange Rates
- Store exchange rate history.
- Map any currency used across the entire history to a user-chosen base currency (USD/EUR/etc.).

### Categories
- Every transaction has at least one category: expenses, income and transfers alike. Each amount counts in exactly one category, so category totals do not overlap (tag totals do).
- A transaction can be split across several categories. Each part has both the *from* and the *to* amount; editing one recalculates the other at the transaction's own rate. See [docs/plans/2026-10-26-category-vs-tag-decisions.md](docs/plans/2026-10-26-category-vs-tag-decisions.md).

### Tags
- Tags support **synonyms**: `#wildberries` == `#wb`.

### Time Periods
- Named time periods (e.g., vacations, rental stays at a specific apartment) that span date ranges.
- Usable as aggregation intervals.

## Aggregation & Reporting
- Aggregate by: time intervals (day/month/year/custom periods), categories, tags, accounts, purchase currency, account currency, mapped base currency, cash vs. non-cash.

## Import
- Import bank statements (format TBD).
- Import push notifications (format TBD).

## Sync
- Offline-first: the app works fully standalone; sync is opportunistic when online.
- Multi-device: any number of user devices share one logical database via a chosen cloud target.
- Pluggable sync provider — at minimum Supabase, S3-compatible (Backblaze B2 / Cloudflare R2), and GitHub repository as candidates. One is active at a time; credentials for all three are persisted so switching is friction-free. **Implemented** (unit-tested against in-memory fakes; not yet verified against the live services): see [docs/plans/2026-05-28-sync-backends-plan.md](docs/plans/2026-05-28-sync-backends-plan.md) (GitHubCsvBackend, SqliteBlobBackend with Supabase + S3 transports).
- Each device has a user-editable name used as its identity in sync metadata; defaults to a UA-derived name with a random 8-char suffix to keep un-renamed devices distinguishable. **Implemented:** see [docs/plans/2026-05-28-sync-settings-plan.md](docs/plans/2026-05-28-sync-settings-plan.md).
- Settings exposes sync status as read-only data: last sync (timestamp, uploader, hash), current local-database hash, and the last cached remote snapshot. Opening Settings never triggers a network call. **Implemented:** see [docs/plans/2026-05-28-sync-settings-plan.md](docs/plans/2026-05-28-sync-settings-plan.md).
- Settings exposes per-provider credential fields. Stored plaintext in localStorage — the realistic threat model (XSS) already loses the whole SQLite database, so at-rest encryption of tokens gains nothing meaningful.
- All settings are per-device and never synced: the SQLite `settings` table (layout, theme) and the localStorage sync state (device name, provider config and credentials, sync snapshots, last error). Without its own provider config a device would not know where to sync from.
