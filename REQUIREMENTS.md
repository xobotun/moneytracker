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
