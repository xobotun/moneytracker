# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal money tracker application. Must work as a standalone app on PCs and mobiles, with cloud sync.

## Tech Stack

- **Frontend:** Vue 3 (Composition API) + TypeScript, built with Vite
- **Backend:** Supabase (auth, PostgreSQL, sync)
- **Package manager:** npm
- **Architecture:** Offline-first — app works standalone, syncs to Supabase when online

### Styling & UI
- **Tailwind CSS v4** for utility-first styling (~90% of CSS).
- **PrimeVue** as primary component library (data tables, forms, date pickers).
- **Radix Vue** for custom headless components when PrimeVue is too opinionated.
- Vue `<style scoped>` for edge cases only.

### Data & State
- **Pinia** for state management — used as a **write-through cache**. SQLite is the source of truth; Pinia stores call repositories to persist changes, then update reactive state.
- **wa-sqlite + IDBBatchAtomicVFS** for local SQLite database (IndexedDB-backed, offline, exportable).
- **Vue Router** for navigation.

### SQLite Conventions (TODO: refine as schema grows)
- **Primary keys:** UUIDs (`TEXT`), generated client-side. Sync-friendly from day one.
- **Timestamps:** Always stored as ISO 8601 UTC strings with `Z` suffix (e.g., `2026-03-15T14:30:00.000Z`). Column names must include `_utc` suffix to make the format explicit (e.g., `updated_at_utc`, `created_at_utc`).
- **Migrations:** Ordered `.ts` files, tracked in a `migrations` table. Run on `Database.init()`.
- **No concurrent DB operations.** The async wa-sqlite build (used for IDBBatchAtomicVFS persistence) relies on Asyncify, which cannot handle multiple in-flight operations on the same connection. Always `await` each query sequentially — never use `Promise.all` with multiple DB calls.

### Quality
- **ESLint** + **Prettier** for linting/formatting.
- **Vitest** + Vue Test Utils for unit/component tests.
- **Playwright** for E2E tests.

### CI/CD & Hosting
- **GitHub Actions**: lint + test on PR, deploy on merge.
- **GitHub Pages** for hosting (static PWA).

## Requirements

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full list. Key domain concepts:

- Multi-account, multi-currency expense/income/transfer tracking.
- Dual-currency transactions (account currency vs. purchase currency) with exchange rate history.
- Tags with synonyms, categories, location, date overrides, named time periods.
- Aggregation across many dimensions (time, tags, accounts, currencies, cash/non-cash).
- Bank statement and push notification import.

## Repository

- Remote: https://github.com/xobotun/moneytracker.git
- Branch: main

## Developer Context

- Author is experienced in Java/Go (~9 YoE) but new to frontend/JavaScript ecosystem.
- Prefer explicit, clear code over clever JS idioms. Explain non-obvious JS/Vue patterns when introducing them.
