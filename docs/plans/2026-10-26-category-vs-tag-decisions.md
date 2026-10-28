# Money Tracker: Category vs. Tag Decisions

**Status:** Decided in discussion with Pavel Maminov, 2026-10-26. The data model is not designed yet.
**Scope:** Categories, merchants, locations, journeys and plain tags (all of them tags), and transaction kinds, in the first version
**Users:** Pavel and his wife (shared household)

---

## 1. Core distinction

Categories, merchants, locations, journeys and plain tags are all **tags**: one table, told apart by a `kind` column. Only plain tags are shown as `#tag`; every other kind has its own field on the transaction.

| Kind | Question answered | Per transaction | Affects totals | Examples |
|---|---|---|---|---|
| **Category** | What kind of spending or income is this? | At least one; several when split, each part with its amounts | Yes. Each amount counts in exactly one category | Food > Groceries, Travel > Flights, Salary, Savings |
| **Merchant** | Who was paid (or, for a refund, who paid)? | At most one | No | Rewe, Amazon, Lufthansa, Wildberries (synonym WB) |
| **Location** | Where was the device when paying? | At most one | No | Germany > Berlin > Rewe Alexanderplatz |
| **Journey** | Which trip or stay was this part of? | At most one | No | Summer 2026 > Lisbon |
| **Tag** (plain) | What else is this connected to? | Any number | No. Tag totals overlap, and the UI should make this clear | #birthday, #mia, #urgent, #work-from-home |

Every kind except categories belongs to the whole transaction; only categories are split into parts.

**Rule of thumb:** If a transaction should be counted in exactly one bucket for budgeting, it is a category. If you want to slice across buckets, it is one of the other kinds.

---

## 2. Decisions

### 2.1 Tags

- **One table, five kinds:** category, merchant, location, journey, and plain tag. People (Mia) are plain tags; a "for whom" field may come later. The kinds are fixed in code, new ones arrive only with app updates, and a tag does not change its kind.
- **Ids:** a short random id of 12 base-62 characters (about 71 bits, for example `4kQ9xZr2BvLm`), so a tag can be renamed. Tags are created rarely and referenced often, so a short id keeps the rows that reference them small. Accounts and account groups get the same kind of id (scheduled in TASKS.md).
- **Names** are unique among the live tags of the same kind and parent, synonyms included. A location and a journey can both be called Berlin.
- **Hierarchy:** a tag can have a parent of the same kind. Any level can be used on a transaction: Everyday food and Posh food are subcategories of Food, but an expensive meal during an 8-hour layover is neither, so it is filed under Food itself.
- **Colour and icon** are inherited from the parent unless the tag sets its own. A new top-level tag gets a random colour from the colour presets and its kind's icon (category: tag, merchant: shop, location: map marker, journey: globe — PrimeIcons has no plane).

### 2.2 Categories

- **Every transaction has at least one category:** expenses, income, and transfers between accounts alike (see 2.8). One rule for every transaction keeps the UI simple and predictable.
- **Single category:** the full transaction amount is assigned to it automatically.
  - Example: Rewe, 84.30 € → Groceries: 84.30 €
- **Multiple categories:** each category gets a part of the transaction, with both a *from* and a *to* amount (they differ when the transaction involves two currencies). How the parts are entered is described in 2.4.
  - Example: Amazon, 140.00 € → Clothing: 60.00 €, Office: 80.00 €
- **Reporting:** each transaction's amount is counted once across categories, so category reports always reconcile with actual spending and income. A category's total for a period shows only the expenses when there are only expenses, only the income when there is only income, and the net together with both parts when there are both.
  - Example: Clothing in July, two orders of 60.00 € and a refund of one of them → −60.00 € (+60.00 €, −120.00 €).

### 2.3 Typed and derived values

This is a rule for the whole UI, not only for the transaction form.

- Every value on a form is either **typed** by the user or **derived** by the app from something else. Derived values are shown in fainter text (about 20% lighter); hovering over or focusing one names its source ("from the rate of 26 Oct", "from Rewe Alexanderplatz").
- Derived values follow their source when it changes. Typed values never change on their own.
- Typing over a derived value makes it typed. A typed value that replaced a derived one offers a small reset button (on hover or focus) that brings the derived value back. Clearing a field counts as typing: the user chose "none".
- What the transaction form derives:
  - the second amount, from the day's applied rate (2.4);
  - category parts, from what is left of the split (2.4);
  - the location, from the device's position (2.6);
  - the merchant, from the location's merchant (2.6);
  - the category, from the merchant's default category (2.6);
  - the journey, from the active journey (2.7).

### 2.4 Entering amounts and splits

- **Transaction amounts.** The user types one side; the other side is derived at the day's applied rate (`applied_rates`, see the exchange-rates decisions) until the user types it too, usually to match what the bank actually charged. The transaction's own rate is *to* ÷ *from*.
- **Derived parts** are filled in so that:
  1. each side's parts add up to that side's total, and
  2. every part follows the transaction's own rate.

  Categories the user has not touched share what is left equally. Changing a total recalculates the derived parts in proportion.
- **Rounding is display-only.** A part is shown rounded to its currency's decimals; the totals row always shows the transaction's own amounts (two parts of 1.005 € show as 1.00 € each, the total as 2.01 €).
- **Typed amounts that do not fit one rate.** When the typed amounts make the two rules above impossible to meet together, the sums win: the typed amounts stay, the derived parts still make each side add up, and the parts no longer share one rate. The UI shows a non-blocking warning and offers to undo the last edit; the transaction can be saved as it is.
- **Typed parts that do not add up.** By default, the split must sum exactly to the transaction total. If the sum of categories isn't equal to the total, the UI shows the difference as a warning. Whether the rate warning shows next to it is decided with the split view's design (postponed 2026-10-27).
- **Negative parts** are allowed, with a non-blocking warning (decided 2026-10-27). A trade-in is one real case: a 100 € shirt bought by handing in an old one is 120 € for the shirt and −20 € for the old one. More often it is a typo.

**Example:** paying 800 AMD in an Armenian shop with a EUR Revolut card. **Bold** amounts are typed by the user; the others are derived and shown fainter.

| Step | The user                                      | Total                    | Groceries            | Gifts                |
|------|-----------------------------------------------|--------------------------|----------------------|----------------------|
| 1    | types 800 AMD spent from the EUR account      | 2.01 € → **800 AMD**     |                      |                      |
| 2    | picks Groceries and Gifts                     | 2.01 € → **800 AMD**     | 1.00 € → 400 AMD     | 1.00 € → 400 AMD     |
| 3    | types 600 AMD for Gifts                       | 2.01 € → **800 AMD**     | 0.50 € → 200 AMD     | 1.51 € → **600 AMD** |
| 4    | types 2.21 € as the total (push notification) | **2.21 €** → **800 AMD** | 0.55 € → 200 AMD     | 1.66 € → **600 AMD** |
| 5    | types 0.60 € for Groceries                    | **2.21 €** → **800 AMD** | **0.60 €** → 200 AMD | 1.61 € → **600 AMD** |

In step 5, Groceries' 200 AMD cannot change (Gifts' 600 AMD and the 800 AMD total are both typed), so Gifts takes the rest of the euros. Groceries now runs at about 333 AMD/€ and Gifts at about 373 AMD/€, so the UI shows the warning, offers to undo the edit, and allows saving.

### 2.5 Synonyms, merging and deleting

- **Synonyms** are extra names of a tag (WB for Wildberries). Transactions show the main name; a synonym finds the tag when typing and matches imported text ("REWE MARKT GMBH" → Rewe).
- **Merging.** Making X a synonym of Y merges X into Y, after a warning:
  - X's transactions move to Y. When one transaction has both as category parts, the parts are added together (Everyday food 5 € + Groceries 3 € → Groceries 8 €).
  - X's children move under Y.
  - X's name and synonyms become synonyms of Y; Y keeps its colour, icon and description.
  - X's details (a location's address, coordinates and merchant; a merchant's default category; a journey's dates) fill the ones Y lacks. Where both have a value and the values differ, the merge asks the user which to keep, or lets them type a third value. A merge only ever happens on the user's initiative, never automatically.
  - X is soft-deleted and remembers Y, so a device that used X before it synced the merge is redirected to Y on its next sync.
  - Merging a tag into one of its own descendants is refused, and the UI shows the path (X > A > Y).
- **Merged names** — a tag's synonyms and the names of the tags merged into it, also through a chain of merges — are listed on the Tags page. A merged name can be removed only while nothing uses it (decided 2026-10-27). What counts as a use was settled with the Tags page: nothing yet, as transactions reference tags by id; once import rules exist, a rule that matches the name will. Removing a name stops it finding the tag (it is kept in the tag's `retired_names`); the merged tag itself stays deleted, as sync redirects through it.
- On the Tags page, making X a synonym of Y is done with X's "Merge into…"; typing the name of another tag at the same level as a synonym is refused like any taken name, so a merge never rides along with other unsaved edits.
- **Duplicates** (same kind, parent and name, for example Rewe created on two devices while offline) are highlighted on the Tags page. The users merge them by hand; the app does not offer it.
- **Loops.** Moving a tag under one of its own descendants is refused. When sync creates a loop (the phone moves Groceries under Food while the laptop, offline, moves Food under Groceries), the later move is undone and the sync result says so.
- **Deleting** is a soft delete, after a warning that says how many transactions use the tag. A deleted tag is no longer shown on its transactions or suggested, but the transactions keep the reference, so restoring the tag brings it back everywhere. A category in use is merged into another category instead (with a warning), since every transaction needs one. Children of a deleted tag move up one level.

### 2.6 Merchants and locations

- **Merchant:** who was paid, or who paid (an Amazon refund). Allowed on every transaction; the UI hides the field on income and transfers by default. A merchant can name a default category (Rewe → Food > Groceries).
- **Location:** where the device was when paying. Locations form a geographic hierarchy down to single stores (Germany > Berlin > Rewe Alexanderplatz), and a store can link to its merchant: Rewe has many stores, each linked to Rewe. The address, the coordinates and the merchant link live in a side table keyed by the tag id; city and country become parent tags.
- **Matching the position.** The nearest known location within about 150 m is filled in, and the next few nearby ones are offered as one-tap choices, since GPS drifts in shopping centres. With nothing in range the location stays empty, the transaction keeps the raw position, and the user can create a location from it. The user can also pick a more specific location, or drop it when it does not matter.
- **A location is a circle** (decided 2026-10-28): its position and a radius, 10 m unless set, so a big place matches from anywhere inside it. "Within about 150 m" is measured from the circle's edge.
- **Kept out of automatic matching** (decided 2026-10-28). Matching is on by default; the user can turn it off for one location or merchant. A location then is never filled in by itself, but is still offered among the nearby ones (a weekly market that moves). A merchant then is not matched by itself to imported lines (bank statements, receipts) that name it (a name too generic to trust).
- **Example:** in a shopping centre the position matches "dm Alexa", so the merchant and the category show dm and Drugstore, faint. Picking "Rewe Alexanderplatz" switches them to Rewe and Food > Groceries. Had the user typed the merchant first, it would stay as typed.

### 2.7 Journeys

- **A journey is a trip or a stay** (a vacation, a rental stay): the named time periods of REQUIREMENTS.md. A holiday through several places uses the hierarchy: Summer 2026 > Lisbon, Summer 2026 > Porto.
- **Dates.** A start and an end date, derived from the first and last transaction of the journey; the user can override them (a plane landing after midnight with no purchase that day). A parent's dates cover its children.
- **"On a journey" switch:** per device, not synced. Turning it on offers to start a new journey or to join an ongoing or recent one (for example, one started on the other user's phone). While it is on, new transactions get the journey as a derived value. Moving on from Lisbon to Porto switches the active journey; the user turns the switch off by hand.
- **Reports** for a journey include only the transactions tagged with it: Netflix renewing at home during the trip is not trip spending. The dates serve the timeline and suggestions during import.

### 2.8 Transaction kinds

- There is no transaction type field. Every transaction moves money from somewhere to somewhere, and each side is either one of the users' accounts or the world (no account: `NULL` in `account_id__from` / `account_id__to`). At least one side is an account. The kind follows from the two sides:

  | From    | To      | Kind                                                           |
  |---------|---------|----------------------------------------------------------------|
  | Account | World   | Expense                                                        |
  | World   | Account | Income                                                         |
  | Account | Account | Transfer (for example, checking to savings, cash withdrawals)  |

- Spending and income reports count only money that leaves to or arrives from the world. A transfer between the users' own accounts is neither, though it still has a category (for example, Savings).

---

## 3. Example transactions

| Transaction | Category | Merchant | Location | Journey | #tags | Kind |
|---|---|---|---|---|---|---|
| Weekly shop, 84.30 € | Food > Groceries | Rewe | Germany > Berlin > Rewe Alexanderplatz | | #weekly-shop | Expense |
| Flight to Lisbon, booked from home, 412.00 € | Travel > Flights | Lufthansa | none (dropped) | Summer 2026 > Lisbon | | Expense |
| Meal during a layover, 38.00 € | Food | | Germany > Frankfurt > Airport | Summer 2026 > Lisbon | | Expense |
| Taxi in Lisbon, 14.20 € | Transport > Taxi | Uber | Portugal > Lisbon | Summer 2026 > Lisbon | | Expense |
| Mia's birthday gift, 45.00 € | Gifts | Amazon | none (online) | | #birthday, #mia | Expense |
| Order, 140.00 € | Clothing: 60.00 €, Office: 80.00 € (split) | Amazon | | | #work-from-home | Expense |
| Refund of the clothing, 60.00 € | Clothing | Amazon | | | | Income |
| Shop, 2.21 € → 800 AMD | Food > Groceries: 0.55 € → 200 AMD, Gifts: 1.66 € → 600 AMD (split) | | Armenia > Yerevan | | | Expense |
| Salary, 3,200.00 € | Salary | | | | | Income |
| Checking → savings, 500.00 € | Savings | | | | | Transfer |
| ATM withdrawal, checking → cash, 100.00 € | Cash withdrawal | | Germany > Berlin | | | Transfer |

---

## 4. TODO (later)

- **Fractional splits:** enter a category's share as a fraction of the transaction (for example, ⅓) instead of as amounts. One fraction covers both the *from* and the *to* amount.
- **Recurrence:** marking repeating transactions (for example, monthly Netflix). Not a tag.
- **"For whom":** a field for the person a purchase is for. People are plain tags until then.

---

## 5. Next steps

- Define the data model (tables and fields) based on these decisions: the `tags` table with `kind` and short ids; side tables for locations (address, coordinates, merchant), merchants (default category) and journeys (dates); category parts with their *from* and *to* amounts and how they are stored (rounding is display-only, see 2.4); how transactions reference the other kinds.
- Draft example screens for transaction entry, split view, and the Tags page.
