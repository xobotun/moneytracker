# Tech Stack Design

Date: 2026-02-22
Status: **COMPLETED** — All decisions implemented as specified.

## Context

Personal money tracker PWA. Offline-first, runs on PCs and mobiles as a standalone installable app. Syncs to Supabase when online. Data-heavy: multi-account, multi-currency transactions with aggregation and reporting.

## Decisions

### Core

- **Vue 3** (Composition API) + **TypeScript** — modern framework with strong typing.
- **Vite** — build tool, dev server, HMR. Default for Vue 3.
- **npm** — package manager.

### Styling & UI

- **Tailwind CSS v4** — utility-first CSS, used for ~90% of styling.
- **PrimeVue** — component library for data tables, date pickers, autocomplete, forms. Covers the data-heavy UI needs.
- **Radix Vue** — headless (unstyled) components for cases where PrimeVue is too opinionated and full design control is needed.
- **Vue `<style scoped>`** — fallback for edge cases (pseudo-elements, complex animations) that utility classes can't express.

### Data & State

- **Pinia** — state management (official Vue 3 store). Typed stores shared across components.
- **wa-sqlite + OPFS** — real SQLite database in the browser via WebAssembly, persisted to Origin Private File System. Enables SQL queries client-side and easy data export (download .sqlite file).
- **Supabase** — backend: auth, PostgreSQL database, cloud sync.
- **Vue Router** — URL-based navigation between views.

### PWA & Offline

- **vite-plugin-pwa** — generates service worker (via Workbox), handles caching strategies, install prompt, manifest.
- **Offline-first architecture** — app works fully standalone with local SQLite. Syncs to Supabase when connectivity is available.

### Quality & CI

- **ESLint** (with vue and typescript plugins) — linting and code patterns.
- **Prettier** — auto-formatting.
- **Vitest** + **Vue Test Utils** — unit and component tests.
- **Playwright** — end-to-end browser tests.
- **GitHub Actions** — CI pipeline: lint + test on PR, deploy on merge to main.
- **GitHub Pages** — hosting. Static PWA, no server needed (Supabase handles backend).

## Key Architectural Notes

- **Dual storage:** SQLite (local, offline) + PostgreSQL via Supabase (cloud, sync). Sync logic TBD.
- **Dual currency per transaction:** account currency amount + purchase currency amount, with exchange rate history.
- **PrimeVue as primary UI, Radix Vue as escape hatch** for custom components.
- **Tailwind + scoped CSS coexist** — Tailwind for bulk styling, scoped CSS for edge cases.
