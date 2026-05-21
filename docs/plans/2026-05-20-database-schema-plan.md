# Persistence Layer Implementation Plan

Status: **TODO** — also, this file is a draft, Claude will need to modify it.

---

# Raw database schema description

Also, supabase must store the hash of the sqlite database file and the last modified date. Separately, so the sqlite file won't change on these two being updated.

## Core tables

### 1. Accounts
(A user's bank account, cash savings or someone's debt)
id: just a sequential number
name: user-entered name of the account. E.g. "Bcc #ironcard KZT" or "Cash AMD"
currency: ISO 4217 currency code, e.g. "EUR". One per account
amount: current balance of the account
tags: list of tags, empty array if no tags. (text, but use json arrays for sqlite to use its json functions)
location_id: if available, where the account is open, nullable.
colour: hex colour code, e.g. "#FF5733"
icon: icon name, e.g. "credit-card" or "cash". Just a placeholder for now.

### 2. Transactions
(Double-entry bookkeeping)
id: uuid-v7
account_from: id of the account that the transaction is from; null when income from "Global economy"
account_to: id of the account that the transaction is to; null when spending on "Global economy"
amount_from: amount of the transaction in the currency of the account_from (Amounts will likely adhere to exchange rates, but there will be cases with custom when exchanging money in person. Hence, two fields)
amount_to: amount of the transaction in the currency of the account_to
currency_from: should match the account_from, unless it's "Global economy". 
currency_to: should match the account_to, unless it's "Global economy".
transaction_date: when the transaction happened; with timezone (e.g. "2013-10-07 04:23:19.120+04:00")
transaction_date_tz: timezone of the transaction_date, e.g. "Europe/Berlin"
date_override: for cases such as when a ticket for February was bought in November, nullable.
date_override_tz: timezone of the transaction_date, e.g. "Europe/Berlin", nullable.
tags: same as in accounts, empty array if no tags.
location_lat: latitude of the transaction location, if available, nullable. (just technical data, if there is no relevant data in the location table)
location_lon: longitude of the transaction location, if available, nullable.
location_id: if available, a reference to a location table, nullable. (takes priority over location_lat and location_lon, if set)

### 3. Exchange rates
(Just a historical cache, so we won't make a request every time we need to convert)
(Likely will use https://docs.openexchangerates.org/reference/historical-json and https://github.com/fawazahmed0/exchange-api as data sources)
(Due to having many providers, there will be cases when there are two or more entries for the same base currency in the same date. It's the currency pairs that may be unique in there)
id: just a sequential number
date: for which the rate is applicable. E.g. "2013-10-07"
base_currency: from which conversions are made, OER's free plan supports only "USD".
rates: a map of currency codes to exchange rates. E.g. `{ "AED": 3.672538, "AFN": 66.809999, "ALL": 125.716501, "AMD": 484.902502, ... }` Not all currencies are guaranteed to be present, depends on a provider.

## User experience tables

### 4. Tags
tag: name of the tag, being the primary key.
description: a short description of the tag, if available, nullable.
synonyms: list of other tags that are synonyms for the tag, empty json array if none. E.g. "wb" should be a synonym for "wildberries".
colour: hex colour code, e.g. "#FF5733"
icon: icon name, e.g. "credit-card" or "cash". Just a placeholder for now.

### 5. Locations
(A physical shop, a frequent geolocation, or an internet site/bank)
id: just a sequential number
name: name of the location, e.g. "REWE" or "Revolut"
description: user-entered description of the location, nullable.
address: address of the location, if available, nullable.
city: city of the location, if available, nullable.
country: country of the location, if available, nullable.
latitude: latitude of the location, if available, nullable.
longitude: longitude of the location, if available, nullable.
tags: same as in accounts, empty array if no tags.

### 6. Account groupings
id: just a sequential number
name: display name of the grouping,
colour: hex colour code, e.g. "#FF5733"
icon: icon name, e.g. "credit-card" or "cash". Just a placeholder for now.
accounts_ids: list of account ids (text, but use json arrays for sqlite to use its json functions)

---

Also, remember to add comments to the tables and rows.
Side note: use https://openexchangerates.github.io/accounting.js/ to format the number on the frontend.
