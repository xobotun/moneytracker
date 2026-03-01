# Project Scaffold Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold the Vue 3 + TypeScript project with all decided dependencies, verify everything works together, and have a deployable "hello world" PWA.

**Architecture:** Vite-based Vue 3 SPA with Tailwind CSS v4, PrimeVue components, Pinia state, Vue Router, ESLint + Prettier, Vitest + Playwright. No wa-sqlite or Supabase yet — those are complex integrations for a later plan.

**Tech Stack:** Vue 3, TypeScript, Vite, Tailwind CSS v4, PrimeVue, Pinia, Vue Router, vite-plugin-pwa, ESLint, Prettier, Vitest, Playwright

---

### Task 1: Scaffold Vue 3 + TypeScript project with Vite

**Step 1: Create the project**

Run from the repo root (`D:\Work\moneytracker`):

```bash
npm create vue@latest . -- --typescript --vue-router --pinia --eslint-with-prettier --vitest --playwright
```

This is Vue's official scaffolding tool (`create-vue`). The `.` tells it to scaffold into the current directory. The flags pre-select all our choices so it won't ask interactive questions.

If it complains about the directory not being empty (due to README.md, CLAUDE.md, etc.), say yes to continue — it won't overwrite existing files unless they conflict.

**Step 2: Verify generated files exist**

Expected new files:
- `package.json` — dependencies and scripts
- `vite.config.ts` — Vite configuration
- `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json` — TypeScript config
- `src/main.ts` — app entry point
- `src/App.vue` — root component
- `src/router/index.ts` — Vue Router setup
- `src/stores/` — Pinia stores directory
- `index.html` — HTML entry point
- `eslint.config.ts` — ESLint flat config
- `.prettierrc.json` — Prettier config
- `e2e/` — Playwright test directory
- `src/components/__tests__/` — Vitest test directory

**Step 3: Install dependencies**

```bash
npm install
```

**Step 4: Verify dev server starts**

```bash
npm run dev
```

Expected: Vite dev server starts on `http://localhost:5173` (or similar port). Ctrl+C to stop.

**Step 5: Verify build works**

```bash
npm run build
```

Expected: Build succeeds, output in `dist/` directory.

**Step 6: Verify tests pass**

```bash
npm run test:unit
```

Expected: Default generated tests pass.

**Step 7: Verify linting passes**

```bash
npm run lint
```

Expected: No errors.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold Vue 3 + TypeScript project with Vite

Includes Vue Router, Pinia, ESLint + Prettier, Vitest, Playwright.
Generated via create-vue."
```

---

### Task 2: Add Tailwind CSS v4

**Step 1: Install Tailwind**

```bash
npm install tailwindcss @tailwindcss/vite
```

Tailwind v4 uses a Vite plugin instead of PostCSS. No `tailwind.config.js` needed — v4 uses CSS-first configuration.

**Step 2: Add Tailwind Vite plugin**

Modify: `vite.config.ts`

Add the Tailwind plugin to the Vite config:

```ts
import tailwindcss from '@tailwindcss/vite'

// Add to plugins array:
plugins: [
  vue(),
  // ... other plugins
  tailwindcss(),
],
```

**Step 3: Add Tailwind CSS import**

Modify: `src/assets/main.css` (or whatever the main CSS file is)

Add at the top:

```css
@import "tailwindcss";
```

Remove or keep the existing generated CSS — we'll clean it up later.

**Step 4: Verify Tailwind works**

Modify `src/App.vue` temporarily — add a Tailwind class like `class="text-red-500"` to any element. Run `npm run dev`, confirm the text turns red in the browser.

Remove the test class after verifying.

**Step 5: Verify build still works**

```bash
npm run build
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Tailwind CSS v4 with Vite plugin"
```

---

### Task 3: Add PrimeVue

**Step 1: Install PrimeVue**

```bash
npm install primevue @primevue/themes
```

**Step 2: Configure PrimeVue in main.ts**

Modify: `src/main.ts`

```ts
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'

// After createApp(App):
app.use(PrimeVue, {
  theme: {
    preset: Aura,
  },
})
```

Aura is PrimeVue's modern theme that works well with Tailwind.

**Step 3: Verify PrimeVue works**

Add a PrimeVue Button to `src/App.vue` temporarily:

```vue
<script setup>
import Button from 'primevue/button'
</script>

<template>
  <Button label="Hello PrimeVue" />
</template>
```

Run `npm run dev`, confirm the styled button renders.

Remove the test button after verifying.

**Step 4: Verify build still works**

```bash
npm run build
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add PrimeVue with Aura theme"
```

---

### Task 4: Add vite-plugin-pwa

**Step 1: Install PWA plugin**

```bash
npm install vite-plugin-pwa -D
```

**Step 2: Configure PWA plugin**

Modify: `vite.config.ts`

```ts
import { VitePWA } from 'vite-plugin-pwa'

// Add to plugins array:
VitePWA({
  registerType: 'prompt',
  manifest: {
    name: 'Money Tracker',
    short_name: 'MoneyTracker',
    description: 'Personal money tracker',
    theme_color: '#ffffff',
    icons: [
      {
        src: 'pwa-192x192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: 'pwa-512x512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  },
})
```

**Step 3: Create placeholder PWA icons**

Create two placeholder PNG icons in `public/`:
- `public/pwa-192x192.png` (192x192)
- `public/pwa-512x512.png` (512x512)

These can be simple colored squares for now — just need to exist for the manifest.

**Step 4: Verify build still works**

```bash
npm run build
```

Expected: `dist/` now includes `manifest.webmanifest` and a service worker file.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add PWA support with vite-plugin-pwa"
```

---

### Task 5: Add a minimal home page to verify everything works together

**Step 1: Clean up generated boilerplate**

Remove the default `create-vue` boilerplate components (HelloWorld, TheWelcome, etc.) from `src/components/`. Keep the directory structure.

**Step 2: Create a simple home view**

Modify: `src/views/HomeView.vue` (or create if not present)

A minimal page using Tailwind classes + one PrimeVue component to prove integration:

```vue
<script setup lang="ts">
import Card from 'primevue/card'
</script>

<template>
  <div class="min-h-screen bg-gray-50 flex items-center justify-center">
    <Card class="w-96">
      <template #title>Money Tracker</template>
      <template #content>
        <p class="text-gray-600">Your offline-first personal finance app.</p>
      </template>
    </Card>
  </div>
</template>
```

**Step 3: Update App.vue**

Simplify `src/App.vue` to just render the router view:

```vue
<template>
  <RouterView />
</template>
```

**Step 4: Verify dev server, build, lint, and tests**

```bash
npm run dev          # check visually
npm run build        # should succeed
npm run lint         # should pass (fix if needed)
npm run test:unit    # update/remove broken tests from boilerplate removal
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: replace boilerplate with minimal home page

Tailwind + PrimeVue Card integration verified."
```

---

### Task 6: Configure GitHub Actions CI and GitHub Pages deploy

**Step 1: Create CI workflow**

Create: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run test:unit
```

**Step 2: Create deploy workflow**

Create: `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
        env:
          BASE_URL: /moneytracker/
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - uses: actions/deploy-pages@v4
        id: deployment
```

Note: Vite's `base` option in `vite.config.ts` will need to handle the `/moneytracker/` prefix for GitHub Pages. We'll set this via env var or config.

**Step 3: Configure Vite base path for GitHub Pages**

Modify: `vite.config.ts`

```ts
base: process.env.BASE_URL || '/',
```

This keeps `/` for local dev but uses `/moneytracker/` in the deploy build.

**Step 4: Verify build with base path**

```bash
BASE_URL=/moneytracker/ npm run build
```

Expected: Built files reference `/moneytracker/` prefix in asset paths.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add GitHub Actions CI and Pages deploy workflows"
```

---

### Summary

After all 6 tasks, you'll have:
- A working Vue 3 + TypeScript app with Vite
- Tailwind CSS v4 for styling
- PrimeVue component library ready to use
- Pinia + Vue Router configured
- PWA support (installable, offline-cacheable)
- ESLint + Prettier for code quality
- Vitest + Playwright for testing
- GitHub Actions for CI (lint + test on PR) and deploy (GitHub Pages on merge)
- Everything committed in clean, incremental commits

**Not included in this plan (for future plans):**
- wa-sqlite + OPFS setup (complex, needs its own plan)
- Supabase integration (auth, sync)
- Radix Vue (add when first needed)
- Actual app features (accounts, transactions, etc.)
