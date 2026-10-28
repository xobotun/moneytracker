# Tags and Accounts: feature ideas

Brainstorm, 2026-10-28, from the code on branch `tags-page` (47db731), TASKS.md, REQUIREMENTS.md, the decision and design docs, and the screenshots in `.playwright-mcp/`. Read-only; nothing was built or tried in the browser.

**Effort:** S = up to a day, M = a few days, L = a week or more.
**Synced model:** *none*; *device-local* (a key in the SQLite `settings` table, like `layout.tagRows`, or localStorage); or the synced table/column it adds. A new synced column has to go into `SYNC_COLUMNS` (and `syncColumns.spec.ts`); a column devices compute alike goes into `EQUALITY_IGNORED_COLUMNS`; a new repair after a merge has to converge by one of the routes in CLAUDE.md "Sync tables".

---

## 1. Must have

### 1. **Archive a tag: keep it on its transactions, stop suggesting it**
- **When:** tidying on a PC after a year. The journey "Summer 2025" is over, the shop on the corner closed, the category "Baby food" is no longer needed. Today the only tool is Delete, and decisions §2.5 says a deleted tag *disappears from its transactions*. People who delete to tidy lose that history from view without noticing.
- **What:** an "Archive" button next to Delete. An archived tag stays on its transactions and in reports. Pickers and the parent Select leave it out; typing its exact name still finds it, marked "(archived)". On the Tags page it is hidden behind a "Show archived" toggle, like "Show deleted". For a tag that is in use, the delete confirmation suggests archiving instead.
- **Edge cases:** an archived parent with live children (the children stay shown, the parent shows as a faint ancestor); merging into an archived tag (allowed, the result stays archived); one device archives a tag while the other uses it offline (no conflict, since archived tags stay valid on transactions, unlike deleted merchants and locations, which no sync repair restores); old journeys could be treated as archived on their own after their end date (a derived value, overridable).
- **Effort:** M · **Synced model:** `tags.archived_at_utc TEXT` (NULL = active). Don't name it `retired_*`: `retired_names` already means something else · **Depends on:** the transaction form's pickers, where most of the value shows. The Tags page part can ship now.

### 2. **Close an account**
- **When:** a card is cancelled, an Armenian account is closed after the move, a savings deposit runs out. `remove` is refused while transactions use the account, so a closed account stays on the Accounts page, in the totals and (later) in the account picker for good.
- **What:** "Close account" in the account dialog, with a date. A closed account moves into a collapsed "Closed accounts" section at the bottom. It is left out of group and page totals and out of pickers. Its history and reports stay. "Reopen" undoes it.
- **Edge cases:** closing with a non-zero balance (warn, and offer the balance correction from #4 or a transfer to another account); a transaction dated after the closing date, e.g. a late refund or one entered offline on the other phone (the account shows "activity after closing" instead of hiding money); a group whose accounts are all closed (hide its block); the currency stays locked.
- **Effort:** S–M · **Synced model:** `accounts.closed_on TEXT` ('YYYY-MM-DD'; NULL = open) · **Depends on:** nothing for the Accounts page. Pickers come with the transaction form.

### 3. **Sync must not hide an account that still holds transactions**
- **When:** Pavel deletes an empty, unused account on his laptop. His wife's phone is offline and records two cash expenses on that account. The account row changed only on the laptop, so the merge simply copies the tombstone across. Delete-wins would only come into play if the phone had also edited the account. The phone's new transactions now point at a deleted account, and its money drops out of every total without a word. `repairTags` restores categories that are still in use. Nothing does the same for accounts.
- **What:** (a) a repair after the merge, like `repairTags` step 3: a deleted account that a live transaction uses comes back, stamped from its own row (`max(deleted_at_utc + 1 ms, updated_at_utc)`) so every device writes the same row, and is reported as `delete-undone`. (b) A "Show deleted accounts" list with Restore on the Accounts page. Today a deleted account cannot be brought back.
- **Edge cases:** the account's group was deleted as well (it returns ungrouped, as the store already handles); the restored account needs a balance rebuild (`mergeDatabases` already runs `recalculateBalances`). The same gap exists for a merchant, location or journey deleted on one device and used on the other: decide whether "hidden on the transaction" is acceptable there, or whether #1 makes it rare enough.
- **Effort:** S–M · **Synced model:** none (a repair plus UI) · **Depends on:** nothing. It is safest to build before the transaction form makes the case common.

### 4. **Check a balance against the bank, and correct it**
- **When:** once a month on the sofa with the bank app open: the bank says 1,204.50 €, the app says 1,191.20 €. The same happens on day one, because REQUIREMENTS says an existing balance is entered as an **income** transaction, so the opening balance would count as income in every report.
- **What:** "Check balance" in the account dialog. Type what the bank shows. If it differs, the app offers a correction transaction for the difference, against the world, in a category that reports show as its own line, outside spending and income. That is a change to decisions §2.2 ("category reports always reconcile with actual spending and income"), so name it there. It also remembers "checked on 12 Oct", shown on the row and fainter as the check gets old. Opening balances use the same mechanism.
- **Edge cases:** checking as of a past date (a statement's closing balance) needs the balance at a date, not today's cache; both people correcting the same account offline make two corrections that add up twice (show both in the account's history and warn when two corrections land within a day of each other); cash wallets ("count your cash"); a correction in a closed account (#2).
- **Effort:** M · **Synced model:** a flag on categories that reports leave out (`tags` column, or a new `category_details` side table, which the merge-conflict machinery would then need to cover); `accounts.checked_on` + the checked balance · **Depends on:** `TransactionsRepository.create` (exists, so the form is not needed); reports, to honour the flag.

### 5. **The most specific place wins when circles overlap**
- **When:** at the till in Rewe Alexanderplatz (25 m), which lies inside "Berlin" (9 km; the screenshot shows exactly this tree). `nearestLocations` measures to each circle's edge, and anything inside counts as 0 m. Inside both circles the two tie at 0 and the order is arbitrary. Standing 5 m outside Rewe's circle, Berlin (0 m) beats Rewe (5 m). Every purchase in the city gets "Berlin".
- **What:** rank the circles that contain the point by size, smallest first, then the rest by distance to their edge. Then a big area such as a city only serves as the fallback, and as the parent of a new location: a location created at a position inside Berlin's circle gets Berlin as its parent, shown as a derived value.
- **Edge cases:** two containing circles of the same size (break the tie by depth in the tree, then by id, so every device agrees); an `auto_match` off circle containing the point (offered, never filled, as now); a parent circle that does not actually contain its child (no problem; the tree and geometry are separate).
- **Effort:** S · **Synced model:** none · **Depends on:** nothing for the derived parent in the location dialog. Matching extends the planned "location from the device position" item of the transaction form.

### 6. **Probable duplicates, not only exact ones**
- **When:** both people are at the same market offline. One creates "Rewe" at the top level, the other "REWE Alex" under Berlin. `duplicates()` only groups tags with the same kind, the **same parent** and the same name, so neither pair is flagged. With ~300 locations and hundreds of merchants (plus statement import later) these pile up.
- **What:** a "Possible duplicates" view per tab. Names that are equal after folding case, accents and punctuation, at any level. Locations whose circles overlap and that share a merchant or have similar names. Merchants where one name contains the other ("Rewe" and "Rewe Markt GmbH"). Each pair has "Merge…" (the existing dialog, user-initiated) and "Not duplicates".
- **Edge cases:** chains with many branches (Rewe stores really are separate locations, so overlap alone must not flag them); "Not duplicates" should be remembered: synced, or the other person sees the same false pair again; the pair's merge still asks about detail conflicts. §2.5 says the app "does not offer" merging duplicates. A list that the user acts on keeps the merge user-initiated, but it is a change to that wording.
- **Effort:** M · **Synced model:** none for detection; a small synced list of dismissed pairs (a JSON column, or a table keyed by a UUIDv5 of the pair so both devices write one row) · **Depends on:** nothing.

### 7. **Currency and time zone from the place, inherited down the tree**
- **When:** paying at a till in Yerevan with a EUR card. The purchase currency has to be picked on every transaction abroad. Or, back in Berlin, entering last week's Tbilisi receipts: the device's zone is now wrong for them.
- **What:** a location (usually a country) can set a currency and an IANA zone. Children inherit them like colour and icon (§2.3 derived values: "from Armenia"). The transaction form derives the purchase currency, and the zone when entering later, from the matched or picked location. A typed value always wins.
- **Edge cases:** duty-free at the airport priced in EUR, or a hotel quoting USD (a per-location override); places near a border; online purchases with no location (fall back to the account currency); a country with two zones (set the zone lower in the tree); deriving the zone from the location must not override a zone that was typed.
- **Effort:** M · **Synced model:** `location_details.currency TEXT`, `location_details.zone TEXT` (both NULL = inherited; merges would ask about them like the other detail fields) · **Depends on:** the transaction form (extends its planned "dual-currency input" and "date/time + timezone picker").

### 8. **Journeys sorted by date, newest first**
- **When:** after three years the Journeys tab holds "Armenia 2024, Christmas, Georgia, Kazakhstan Jan, Lisbon, Summer 2025, Summer 2026…" in alphabetical order. The one you want is almost always the latest.
- **What:** on the Journeys tab, siblings sort by start date, newest first, with journeys that have no dates yet at the top. Optionally add year headers. Other tabs stay alphabetical.
- **Edge cases:** derived dates come from `journeyDates`, which runs one query per journey and only for detailed rows today. With hundreds of journeys, and with slim rows also needing the order, it should become one grouped query. Children of a long stay should sort by date too.
- **Effort:** S–M · **Synced model:** none · **Depends on:** nothing.

### 9. **Search that forgives**
- **When:** looking for "the place on Kollwitzplatz", "Doner" for "Döner", "cafe" for "Café", or "all Rewe stores" among 300 locations. `tagMatches` looks only at names, synonyms and merged names, and it only folds case.
- **What:** ignore accents and punctuation (NFD plus stripping combining marks; "C&A" ≈ "CA"), and also match a location's address and description and a row's linked tag (a location's merchant, a merchant's default category). Show why a row matched when it was not by name ("address: Kollwitzplatz").
- **Edge cases:** letters that do not decompose (ß, ı, Armenian and Georgian scripts; leave them as they are); make the same folding available to the duplicate check (#6) and the future pickers; the map view uses the same filter, so "Rewe" on the map shows every Rewe store.
- **Effort:** S · **Synced model:** none · **Depends on:** nothing.

### 10. **A default account per device**
- **When:** at the till. Pavel's phone should start with Pavel's card and his wife's phone with hers. Abroad, paying cash in AMD should start with the AMD wallet.
- **What:** each device remembers its default account (Settings, or a star on the Accounts page), plus a default cash account per currency. The transaction form derives the account from these: shown faint, and typing over it is allowed.
- **Edge cases:** the default account is closed (#2) or deleted (fall back to none, and say so); a currency with no cash account; a shared joint account.
- **Effort:** S · **Synced model:** device-local (`settings`) · **Depends on:** the transaction form.

---

## 2. Nice to see

### 1. **How often and how recently a tag is used**
- **When:** tidying merchants: "is this one used at all?", "which of these two duplicates is the real one?"
- **What:** a count and a "last used" date on detailed rows, an optional sort by use, and a filter "unused for a year", which gives the candidates for archiving (#1 above).
- **Edge cases:** journeys and parents (count the subtree, or only the tag itself? show both); accounts count as uses (`usageCount` already includes them). Per-row counts were a listed non-goal in the Tags page design §1.
- **Effort:** S–M (one grouped query) · **Synced model:** none · **Depends on:** transactions being entered.

### 2. **"Show its transactions" from a tag or account row**
- **When:** before a merge or an archive, or when a number looks wrong: what actually uses this?
- **What:** a row action that opens the transaction list filtered by that tag, location subtree, journey or account.
- **Edge cases:** archived or deleted tags (the filter should still work); a location's subtree versus the location alone.
- **Effort:** S once the list exists · **Synced model:** none · **Depends on:** the planned transaction list with filters.

### 3. **Select several: merge, move or archive at once**
- **When:** after a statement import, merging five spellings of "REWE" one by one through Edit → Merge into… → pick → confirm.
- **What:** a selection mode on the Tags page (like the Accounts page's reorder mode). With several rows selected: merge into one, move under a parent, archive.
- **Edge cases:** detail conflicts across N sources (ask once per field and list every distinct value); one transaction using several of them as category parts (they are summed, as now); selection across levels where one is an ancestor of another (refuse with the path, as now). The merge stays user-initiated (§2.5).
- **Effort:** M · **Synced model:** none · **Depends on:** nothing. Becomes valuable once import exists.

### 4. **Renaming offers to keep the old name**
- **When:** Tinkoff becomes T-Bank, or a typo gets fixed. Searching for the old name finds nothing, and an imported line with the old name will not match.
- **What:** on a rename, a checkbox "Keep 'Tinkoff' as another name". It is on by default, and off when the change looks like a typo (an edit distance of 1–2).
- **Edge cases:** the old name is taken at that level (refused, as typed synonyms already are); renaming back and forth (no repeats).
- **Effort:** S · **Synced model:** none · **Depends on:** nothing.

### 5. **Find places and addresses on the map**
- **When:** on a PC with no GPS, adding the café from yesterday: you have to pan to it by hand today, and the address is typed separately.
- **What:** a search box on the location map (OSM Nominatim or Photon) that jumps to a place. After placing the pin, offer the address found there as a derived value.
- **Edge cases:** it needs the network (show it as unavailable offline); Nominatim's usage policy allows at most one request per second and asks for no autocomplete-per-keystroke; results come in the local language and script; it sends a position to a third party (the OSM tiles already reveal the area, but say so).
- **Effort:** M · **Synced model:** none · **Depends on:** nothing.

### 6. **A merchant's stores**
- **When:** "where are all our Rewes?", or adding a new store of a chain.
- **What:** the merchant dialog lists the locations linked to it, has "Add a store" (a new location with the merchant already set) and "Show on the map".
- **Edge cases:** stores of a merchant that was merged (they already move with the merge); deleted stores.
- **Effort:** S–M · **Synced model:** none · **Depends on:** nothing.

### 7. **Category from the place, and from history**
- **When:** Rewe's default is Groceries, but "Rewe To Go" at the station is always Lunch. Amazon has no sensible default at all.
- **What:** (a) a location can set its own default category, which comes before its merchant's. (b) With no typed default, derive one from the last few transactions with that merchant or location ("usually Clothing"), shown faint with its source.
- **Edge cases:** a split transaction (count each part, or only the largest?); income from the same merchant (a refund) should not drive an expense default; the order of sources must be one documented rule.
- **Effort:** M · **Synced model:** `location_details.default_category_id` for (a); none for (b) · **Depends on:** the transaction form.

### 8. **Hide amounts at the till**
- **When:** opening the app in a queue with people looking over your shoulder.
- **What:** a per-device toggle that blurs balances and totals until tapped.
- **Edge cases:** screenshots and the app switcher preview (blur before the page hides); screen readers (announce "hidden").
- **Effort:** S · **Synced model:** device-local (`settings`) · **Depends on:** nothing.

### 9. **Currency pockets and cash per currency**
- **When:** a Revolut or Wise card with EUR, USD and AMD pockets, or a wallet holding euros, drams and lari. Each is one account per currency, made one by one.
- **What:** in a group, "Add a pocket in another currency" copies the look and the group and asks only for the currency. The same for a cash wallet while travelling.
- **Edge cases:** names ("Revolut AMD" versus a pocket that shows the currency as its name); closing a pocket (#2).
- **Effort:** S · **Synced model:** none · **Depends on:** nothing.

### 10. **Whose account is it**
- **When:** the account order syncs to both phones, and the wife's cards are in the way on Pavel's phone, and the other way round.
- **What:** filter the Accounts page per device by an account tag (one tag per person plus #joint; accounts already carry plain tags), or an owner field. Each device shows "mine and joint" first, or only those.
- **Edge cases:** totals (all accounts, or only the shown ones? say which); an account that has no owner tag.
- **Effort:** S (tag filter) to M (owner field) · **Synced model:** none with tags, plus a device-local filter · **Depends on:** nothing.

### 11. **Account identifiers for import: IBAN, card numbers, old cards**
- **When:** a card is replaced: same account, new last four digits. Push notifications and statements name the card ("*4821"), not the account.
- **What:** an account lists its identifiers (IBAN, the card's last four digits) with optional "valid until", so late transactions on the old card still find it.
- **Edge cases:** two people's cards on one joint account; the same last four digits on two banks (also match the bank name); identifiers are personal data that syncs to the remote (the remote already holds everything).
- **Effort:** S (model + dialog) · **Synced model:** `accounts.identifiers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(…))` · **Depends on:** import; extends the planned "mapping rules from raw entries to transactions, accounts, and tags".

### 12. **What a category is for: spending, income, transfers**
- **When:** entering an expense, the category picker also offers Salary, Savings and Cash withdrawal.
- **What:** a category can be marked for spending, income, transfers or any (inherited down the tree). Pickers show the matching ones first and the rest after a divider. It can be derived from how the category was used if nothing is typed.
- **Edge cases:** refunds (income in a spending category, so never hide the rest); it fits the report-excluded flag from #4 (one field with a few values).
- **Effort:** S–M · **Synced model:** a category flag (same place as #4's) · **Depends on:** the transaction form.

### 13. **Suggest a journey when far from home**
- **When:** the first purchase in Tbilisi, while the "On a journey" switch is still off.
- **What:** when the matched location is in another country than the home location (accounts have `location_id`, a planned picker), offer to start or join a journey.
- **Edge cases:** commuting across a nearby border; a long stay that is really a second home; the switch stays per device (§2.7), so the other person's phone asks separately.
- **Effort:** M · **Synced model:** none · **Depends on:** the transaction form, the planned "On a journey" switch and the account home-location picker; extends that switch.

### 14. **Starter categories, the same on every device**
- **When:** the first run. Every transaction needs a category, so an empty Categories tab blocks the first entry.
- **What:** offer a short starter tree (Food › Groceries / Eating out, Transport, Housing, Salary, Savings, Cash withdrawal, Balance correction…) that the user can untick.
- **Edge cases:** two devices seeding while offline would create every category twice, so the seeded tags need deterministic ids (a name-based id like `nameBasedId`, cut to a short id) so sync merges them as one; seeding is offered only on an empty database.
- **Effort:** S–M · **Synced model:** none (only ordinary rows) · **Depends on:** extends the planned "first-run onboarding".

### 15. **Small Tags page comforts**
- **When:** everyday tidying.
- **What:** "Add 'Kaufland'" right from a filter with no match; collapsed branches remembered per device, plus Collapse all / Expand all; the map's "3 locations have no position" becomes a link that lists them for fixing; the deleted list sorted by deletion date, with the date; search with the wrong keyboard layout ("куцу" finds "rewe", for ЙЦУКЕН/Latin, and Armenian and Georgian layouts if wanted).
- **Edge cases:** a remembered collapse for a tag that no longer exists (ignore it); the wrong-layout match should rank below real matches.
- **Effort:** S each · **Synced model:** device-local for the collapse state · **Depends on:** nothing.

---

## 3. Too cumbersome, or too specific

1. **Offline map tiles.** At a till abroad without roaming, the map is blank. But the map is only for tidying: matching works offline, because positions are local. Bulk-downloading OSM tiles is against the tile usage policy, and a country's tiles at street zoom take hundreds of MB per device.
2. **Building the place tree from geocoding** (country › region › city created on their own). It is the country tracker again. Admin levels differ per country (German Länder, Armenian marzer, Russian oblasts and districts), names come in whichever language the service returns ("Deutschland" next to a hand-made "Germany"), and the automatic tree would keep duplicating and fighting the hand-made one. Finding an address (Nice #5) gets most of the value.
3. **Automatic transliteration across scripts** (Ереван = Yerevan = Երևան). Every script has several romanisations (Erevan, Yerevan), and loose matching produces false hits. A synonym typed once does it exactly.
4. **Undo a merge.** A merge rewrites references on every device after sync and *adds category parts together*, which loses the split. Undoing it needs a synced journal of every changed row and a rule for edits made after the merge. The can't-undo warning and a careful dialog cost far less.
5. **Private accounts inside the shared database.** Everything syncs to both people and to the remote. Privacy would mean encrypting rows per person, and every sum, hash and merge would then work on data it cannot read. A second database is the honest answer.
6. **Location shapes instead of circles** (an airport, a mall, a long market street). Drawing and editing polygons on a phone, with point-in-polygon matching, synced geometry and merge conflicts on shapes. A radius plus a few child locations covers it.
7. **Merchant logos fetched from the web** (favicons, Clearbit, Brandfetch). These are third-party services that see which shops you use, with licensing questions and dead APIs. The icons design already chose uploads, which sync once and are deduplicated by content.
8. **Budgets per journey or category.** Budgets are a feature of their own (periods, rollover, alerts) that is not in REQUIREMENTS. A journey budget alone would be the odd one out. Revisit after reports exist.
9. **Live balances from banks (open banking).** It needs a licensed server-side aggregator and per-country bank coverage (none for Armenian and Kazakh banks through EU PSD2), which a static PWA with no backend cannot host. Statement and push import is the planned route.
10. **"Last edited by" on every row.** It would need an `updated_by` column on every synced table, left out of equality so identical edits do not conflict, plus UI everywhere. For a household of two, asking each other is cheaper. The planned conflict email covers the case that matters, a lost edit.
