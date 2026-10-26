# Money Tracker: Category vs. Tag Decisions

**Status:** Draft, based on discussion with Pavel Maminov; revised 2026-10-26
**Scope:** Data model for categories, tags, and transaction kinds in the first version
**Users:** Pavel and his wife (shared household)

---

## 1. Core distinction

|                           | Category                                           | Tag                                                             |
|---------------------------|----------------------------------------------------|-----------------------------------------------------------------|
| **Question answered**     | What kind of spending or income is this?           | What is this connected to?                                      |
| **Count per transaction** | At least one; several when split                   | Zero or many                                                    |
| **Defined by**            | Predefined set explicitly created by the two users | Free-form, created by the users as needed                       |
| **Affects totals**        | Yes. Each amount counts in exactly one category    | No. Tag totals overlap and are for filtering and reporting only |
| **Examples**              | Groceries, Travel, Clothing, Health, Salary        | #lisbon-trip-2026, #birthday-mia, #urgent, #rewe                |

**Rule of thumb:** If a transaction should be counted in exactly one bucket for budgeting, it is a category. If you want to slice across buckets, it is a tag.

---

## 2. Decisions

### 2.1 Categories

- **Every transaction has at least one category:** expenses, income, and transfers between accounts alike (see 2.4). One rule for every transaction keeps the UI simple and predictable.
- **Single category:** the full transaction amount is assigned to it automatically.
  - Example: Rewe, 84.30 € → Groceries: 84.30 €
- **Multiple categories:** each category gets a part of the transaction, with both a *from* and a *to* amount (they differ when the transaction involves two currencies). How the parts are entered is described in 2.2.
  - Example: Amazon, 140.00 € → Clothing: 60.00 €, Office: 80.00 €
- **Reporting:** each transaction's amount is counted once across categories, so category reports always reconcile with actual spending and income.

### 2.2 Entering amounts and splits

- **Typed and derived amounts.** Every amount on the form is either typed by the user or derived from the others. Derived amounts are shown in a fainter text colour (about 20% lighter) than typed ones.
- **Transaction amounts.** The user types one side; the other side is derived at the day's applied rate (`applied_rates`, see the exchange-rates decisions) until the user types it too, usually to match what the bank actually charged. The transaction's own rate is *to* ÷ *from*.
- **Derived parts** are filled in so that:
  1. each side's parts add up to that side's total, and
  2. every part follows the transaction's own rate.

  Categories the user has not touched share what is left equally. Changing a total recalculates the derived parts in proportion.
- **Rounding is display-only.** A part is shown rounded to its currency's decimals; the totals row always shows the transaction's own amounts (two parts of 1.005 € show as 1.00 € each, the total as 2.01 €).
- **Typed amounts that do not fit one rate.** When the typed amounts make the two rules above impossible to meet together, the sums win: the typed amounts stay, the derived parts still make each side add up, and the parts no longer share one rate. The UI shows a non-blocking warning and offers to undo the last edit; the transaction can be saved as it is.
- **Typed parts that do not add up.** By default, the split must sum exactly to the transaction total. If the sum of categories isn't equal to the total, the UI shows the difference as a warning.

**Example:** paying 800 AMD in an Armenian shop with a EUR Revolut card. **Bold** amounts are typed by the user; the others are derived and shown fainter.

| Step | The user                                      | Total                    | Groceries            | Gifts                |
|------|-----------------------------------------------|--------------------------|----------------------|----------------------|
| 1    | types 800 AMD spent from the EUR account      | 2.01 € → **800 AMD**     |                      |                      |
| 2    | picks Groceries and Gifts                     | 2.01 € → **800 AMD**     | 1.00 € → 400 AMD     | 1.00 € → 400 AMD     |
| 3    | types 600 AMD for Gifts                       | 2.01 € → **800 AMD**     | 0.50 € → 200 AMD     | 1.51 € → **600 AMD** |
| 4    | types 2.21 € as the total (push notification) | **2.21 €** → **800 AMD** | 0.55 € → 200 AMD     | 1.66 € → **600 AMD** |
| 5    | types 0.60 € for Groceries                    | **2.21 €** → **800 AMD** | **0.60 €** → 200 AMD | 1.61 € → **600 AMD** |

In step 5, Groceries' 200 AMD cannot change (Gifts' 600 AMD and the 800 AMD total are both typed), so Gifts takes the rest of the euros. Groceries now runs at about 333 AMD/€ and Gifts at about 373 AMD/€, so the UI shows the warning, offers to undo the edit, and allows saving.

### 2.3 Tags

*Under discussion, see open questions 1 and 2.*

- **Purpose:** context such as trip, person, purpose, or urgency.
- **Effect on totals:** none. Tags are used for filtering and reporting. Tag totals may overlap, and the UI should make this clear.
- **Structure:** hierarchical. A parent tag can have child tags.
  - Example: *Trips* > *Lisbon 2026*. Filtering by *Trips* includes all child tags.
- **Visual:** each tag can have a color or icon to distinguish tag types (for example, trips in blue, people in green).
- **Shop / merchant:** kept as a tag (#rewe, #amazon). A separate merchant field can be added later for auto-categorization, but it is not part of the first version.

### 2.4 Transaction kinds

- There is no transaction type field. Every transaction moves money from somewhere to somewhere, and each side is either one of the users' accounts or the world (no account: `NULL` in `account_id__from` / `account_id__to`). At least one side is an account. The kind follows from the two sides:

  | From    | To      | Kind                                                           |
  |---------|---------|----------------------------------------------------------------|
  | Account | World   | Expense                                                        |
  | World   | Account | Income                                                         |
  | Account | Account | Transfer (for example, checking to savings, cash withdrawals)  |

- Spending and income reports count only money that leaves to or arrives from the world. A transfer between the users' own accounts is neither, though it still has a category (for example, Savings).

---

## 3. Example transactions

| Transaction | Category | Tags | Kind |
|---|---|---|---|
| Rewe, 84.30 € | Groceries | #rewe, #weekly-shop | Expense |
| Lufthansa, 412.00 € | Travel | #trip-lisbon-2026 | Expense |
| Mia's birthday gift, 45.00 € | Gifts | #birthday, #mia, #urgent | Expense |
| Dentist co-pay, 25.00 € | Health | #family | Expense |
| Amazon, 140.00 € | Clothing: 60.00 €, Office: 80.00 € (split) | #work-from-home | Expense |
| Shop in Armenia, 2.21 € → 800 AMD | Groceries: 0.55 € → 200 AMD, Gifts: 1.66 € → 600 AMD (split) | none | Expense |
| Salary, 3,200.00 € | Salary | none | Income |
| Transfer checking → savings, 500.00 € | Savings | none | Transfer, not in spending or income reports |

---

## 4. Open questions

1. **Tags** (next to discuss): the hierarchy in 2.3 against the current `tags` table, which is keyed by the tag name and has no parent column; tag synonyms (`#wb` = `#wildberries`, see REQUIREMENTS.md), which this doc does not cover yet; colour and icon, which the schema already requires on every tag; attributes that may become tags (recurrence, see 5).
2. **Merchants and locations** (together with 1): a shop as a tag (2.3) overlaps with the existing `locations` table.

---

## 5. TODO (later)

- **Fractional splits:** enter a category's share as a fraction of the transaction (for example, ⅓) instead of as amounts. One fraction covers both the *from* and the *to* amount.
- **Recurrence:** marking repeating transactions (for example, monthly Netflix), probably as a tag (see open question 1).

---

## 6. Next steps

- Confirm open questions above.
- Define the data model (tables and fields) based on these decisions, including how split parts are stored (rounding is display-only, see 2.2).
- Draft example screens for transaction entry, split view, and tag management.
