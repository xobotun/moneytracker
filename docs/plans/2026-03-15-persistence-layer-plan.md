# Persistence Layer Implementation Plan

Status: **COMPLETED** — Implemented with IDBBatchAtomicVFS instead of OPFS/OPFSCoopSyncVFS. All OPFS references in this document are outdated; the actual implementation uses IndexedDB-backed persistence via IDBBatchAtomicVFS and the async WASM build with a mutex for Asyncify safety (see commits dc38b6b, 0f0244f).

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up wa-sqlite with OPFS persistence and migrate the layout settings store to use SQLite as source of truth via a write-through Pinia cache.

**Architecture:** `Database` class wraps wa-sqlite + OPFSCoopSyncVFS. Repository classes provide typed data access. Pinia stores call repositories in actions, then update reactive state. App blocks on DB init before mounting Vue.

**Tech Stack:** wa-sqlite (WASM SQLite), OPFSCoopSyncVFS (OPFS persistence), Pinia (write-through cache), Vitest (unit tests)

---

### Task 1: Install wa-sqlite and configure Vite

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`

**Step 1: Install wa-sqlite**

Run: `npm install wa-sqlite`

**Step 2: Install coi-serviceworker for GitHub Pages COOP/COEP headers**

Run: `npm install coi-serviceworker`

**Step 3: Add COOP/COEP headers to Vite dev server**

In `vite.config.ts`, add a custom plugin to the `plugins` array:

```typescript
// Inside plugins array, after VitePWA(...)
{
  name: 'cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  },
},
```

Also add `optimizeDeps` to prevent Vite from pre-bundling the WASM module:

```typescript
optimizeDeps: {
  exclude: ['wa-sqlite'],
},
```

**Step 4: Register coi-serviceworker for production (GitHub Pages)**

Copy `node_modules/coi-serviceworker/coi-serviceworker.min.js` to `public/coi-serviceworker.min.js`.

Add to `index.html` `<head>` before other scripts:

```html
<script src="/coi-serviceworker.min.js"></script>
```

**Step 5: Verify dev server starts**

Run: `npm run dev`
Expected: No errors. Console may show SharedArrayBuffer is available.

**Step 6: Commit**

```
feat: add wa-sqlite dependency and configure COOP/COEP headers
```

---

### Task 2: Create Database class

**Files:**
- Create: `src/db/Database.ts`
- Create: `src/db/__tests__/Database.spec.ts`

**Step 1: Write the test**

```typescript
// src/db/__tests__/Database.spec.ts
import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../Database'

describe('Database', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('initializes an in-memory database', async () => {
    db = new Database()
    await db.init()
    // If init succeeds without throwing, WASM loaded correctly
    expect(db.isOpen()).toBe(true)
  })

  it('executes a CREATE TABLE and INSERT', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
    await db.run('INSERT INTO test (name) VALUES (?)', ['hello'])
    const rows = await db.exec<{ id: number; name: string }>('SELECT * FROM test')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('hello')
  })

  it('returns changes and lastInsertRowId from run()', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
    const result = await db.run('INSERT INTO test (name) VALUES (?)', ['hello'])
    expect(result.changes).toBe(1)
    expect(result.lastInsertRowId).toBe(1)
  })

  it('supports parameterized queries in exec()', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)')
    await db.run('INSERT INTO test (val) VALUES (?)', ['a'])
    await db.run('INSERT INTO test (val) VALUES (?)', ['b'])
    const rows = await db.exec<{ val: string }>('SELECT val FROM test WHERE val = ?', ['b'])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.val).toBe('b')
  })

  it('close() prevents further operations', async () => {
    db = new Database()
    await db.init()
    await db.close()
    await expect(db.exec('SELECT 1')).rejects.toThrow()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/Database.spec.ts`
Expected: FAIL — `../Database` module not found.

**Step 3: Implement Database class**

```typescript
// src/db/Database.ts
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs'
import * as SQLite from 'wa-sqlite'

export interface RunResult {
  changes: number
  lastInsertRowId: number
}

export class Database {
  private sqlite3: SQLiteAPI | null = null
  private db: number | null = null

  /** Initialize with an optional OPFS file path. Omit for in-memory. */
  async init(filePath?: string): Promise<void> {
    const module = await SQLiteESMFactory()
    this.sqlite3 = SQLite.Factory(module)

    if (filePath) {
      // OPFS mode — caller must register VFS before calling init.
      // For now, in-memory is the default for tests.
      this.db = await this.sqlite3.open_v2(filePath)
    } else {
      this.db = await this.sqlite3.open_v2(':memory:')
    }
  }

  isOpen(): boolean {
    return this.sqlite3 !== null && this.db !== null
  }

  /** Execute a query and return all result rows as objects. */
  async exec<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureOpen()
    const rows: T[] = []

    for await (const stmt of this.sqlite3!.statements(this.db!, sql)) {
      if (params) {
        this.sqlite3!.bind_collection(stmt, params)
      }
      const columns = this.sqlite3!.column_names(stmt)
      while (await this.sqlite3!.step(stmt) === SQLite.SQLITE_ROW) {
        const row = this.sqlite3!.row(stmt)
        const obj = Object.fromEntries(columns.map((col, i) => [col, row[i]])) as T
        rows.push(obj)
      }
    }

    return rows
  }

  /** Execute a statement and return changes + lastInsertRowId. */
  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    this.ensureOpen()

    for await (const stmt of this.sqlite3!.statements(this.db!, sql)) {
      if (params) {
        this.sqlite3!.bind_collection(stmt, params)
      }
      await this.sqlite3!.step(stmt)
    }

    return {
      changes: this.sqlite3!.changes(this.db!),
      lastInsertRowId: this.sqlite3!.last_insert_id(this.db!) as number,
    }
  }

  async close(): Promise<void> {
    if (this.sqlite3 && this.db !== null) {
      await this.sqlite3.close(this.db)
    }
    this.sqlite3 = null
    this.db = null
  }

  private ensureOpen(): void {
    if (!this.sqlite3 || this.db === null) {
      throw new Error('Database is not open')
    }
  }
}
```

> **Note:** The wa-sqlite API uses `SQLiteAPI` as the type for the factory result. If TypeScript can't find the type, check wa-sqlite's type exports — you may need `import type { SQLiteAPI } from 'wa-sqlite'` or reference `wa-sqlite/src/types`.

**Step 4: Run tests**

Run: `npx vitest run src/db/__tests__/Database.spec.ts`
Expected: All 5 tests PASS.

> **Troubleshooting:** If WASM fails to load in Vitest, you may need to configure Vitest's `server.deps.inline` to include `wa-sqlite`, or use the `vitest-wasm` plugin. Check the Vitest docs for WASM module support.

**Step 5: Commit**

```
feat: add Database class wrapping wa-sqlite
```

---

### Task 3: Create migration runner

**Files:**
- Create: `src/db/migrations/index.ts`
- Create: `src/db/__tests__/migrations.spec.ts`

**Step 1: Write the test**

```typescript
// src/db/__tests__/migrations.spec.ts
import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../Database'
import { runMigrations, type Migration } from '../migrations'

describe('runMigrations', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('creates the migrations table on first run', async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [])
    const rows = await db.exec('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', 'migrations'])
    expect(rows).toHaveLength(1)
  })

  it('applies migrations in order', async () => {
    db = new Database()
    await db.init()
    const migrations: Migration[] = [
      { version: 1, up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY)' },
      { version: 2, up: 'CREATE TABLE t2 (id INTEGER PRIMARY KEY)' },
    ]
    await runMigrations(db, migrations)

    const tables = await db.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('t1', 't2') ORDER BY name"
    )
    expect(tables.map((t) => t.name)).toEqual(['t1', 't2'])
  })

  it('skips already-applied migrations', async () => {
    db = new Database()
    await db.init()
    const migrations: Migration[] = [
      { version: 1, up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY)' },
    ]
    await runMigrations(db, migrations)
    // Running again should not throw (table already exists)
    await runMigrations(db, migrations)
    const applied = await db.exec<{ version: number }>('SELECT version FROM migrations')
    expect(applied).toHaveLength(1)
  })

  it('applies only new migrations on second run', async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [
      { version: 1, up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY)' },
    ])
    await runMigrations(db, [
      { version: 1, up: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY)' },
      { version: 2, up: 'CREATE TABLE t2 (id INTEGER PRIMARY KEY)' },
    ])
    const applied = await db.exec<{ version: number }>('SELECT version FROM migrations ORDER BY version')
    expect(applied.map((r) => r.version)).toEqual([1, 2])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/migrations.spec.ts`
Expected: FAIL — `../migrations` module not found.

**Step 3: Implement migration runner**

```typescript
// src/db/migrations/index.ts
import type { Database } from '../Database'

export interface Migration {
  version: number
  up: string
}

export async function runMigrations(db: Database, migrations: Migration[]): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at_utc TEXT NOT NULL
    )
  `)

  const applied = await db.exec<{ version: number }>('SELECT version FROM migrations')
  const appliedVersions = new Set(applied.map((r) => r.version))

  const sorted = [...migrations].sort((a, b) => a.version - b.version)

  for (const migration of sorted) {
    if (appliedVersions.has(migration.version)) continue
    await db.run(migration.up)
    await db.run('INSERT INTO migrations (version, applied_at_utc) VALUES (?, ?)', [
      migration.version,
      new Date().toISOString(),
    ])
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/db/__tests__/migrations.spec.ts`
Expected: All 4 tests PASS.

**Step 5: Commit**

```
feat: add migration runner for wa-sqlite
```

---

### Task 4: Create settings migration and SettingsRepository

**Files:**
- Create: `src/db/migrations/001_settings.ts`
- Create: `src/db/repositories/SettingsRepository.ts`
- Create: `src/db/repositories/__tests__/SettingsRepository.spec.ts`

**Step 1: Write the migration**

```typescript
// src/db/migrations/001_settings.ts
import type { Migration } from './index'

export const migration: Migration = {
  version: 1,
  up: `
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    )
  `,
}
```

**Step 2: Write the test**

```typescript
// src/db/repositories/__tests__/SettingsRepository.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { SettingsRepository } from '../SettingsRepository'

describe('SettingsRepository', () => {
  let db: Database
  let repo: SettingsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration])
    repo = new SettingsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('returns null for a missing key', async () => {
    expect(await repo.get('nonexistent')).toBeNull()
  })

  it('stores and retrieves a string value', async () => {
    await repo.set('theme', 'dark')
    expect(await repo.get<string>('theme')).toBe('dark')
  })

  it('stores and retrieves a number value', async () => {
    await repo.set('fontSize', 14)
    expect(await repo.get<number>('fontSize')).toBe(14)
  })

  it('stores and retrieves a boolean value', async () => {
    await repo.set('enabled', true)
    expect(await repo.get<boolean>('enabled')).toBe(true)
  })

  it('stores and retrieves an object value', async () => {
    const obj = { a: 1, b: 'two' }
    await repo.set('complex', obj)
    expect(await repo.get('complex')).toEqual(obj)
  })

  it('overwrites an existing key', async () => {
    await repo.set('key', 'first')
    await repo.set('key', 'second')
    expect(await repo.get<string>('key')).toBe('second')
  })

  it('deletes a key', async () => {
    await repo.set('key', 'value')
    await repo.delete('key')
    expect(await repo.get('key')).toBeNull()
  })

  it('getAll() returns all settings as a record', async () => {
    await repo.set('a', 1)
    await repo.set('b', 'two')
    const all = await repo.getAll()
    expect(all).toEqual({ a: 1, b: 'two' })
  })

  it('getAll() returns empty record when no settings exist', async () => {
    expect(await repo.getAll()).toEqual({})
  })
})
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/__tests__/SettingsRepository.spec.ts`
Expected: FAIL — `../SettingsRepository` module not found.

**Step 4: Implement SettingsRepository**

```typescript
// src/db/repositories/SettingsRepository.ts
import type { Database } from '../Database'

export class SettingsRepository {
  constructor(private db: Database) {}

  async get<T>(key: string): Promise<T | null> {
    const rows = await this.db.exec<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [key],
    )
    if (rows.length === 0) return null
    return JSON.parse(rows[0]!.value) as T
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO settings (key, value, updated_at_utc) VALUES (?, ?, ?)',
      [key, JSON.stringify(value), new Date().toISOString()],
    )
  }

  async delete(key: string): Promise<void> {
    await this.db.run('DELETE FROM settings WHERE key = ?', [key])
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.db.exec<{ key: string; value: string }>('SELECT key, value FROM settings')
    const result: Record<string, unknown> = {}
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value)
    }
    return result
  }
}
```

**Step 5: Run tests**

Run: `npx vitest run src/db/repositories/__tests__/SettingsRepository.spec.ts`
Expected: All 9 tests PASS.

**Step 6: Commit**

```
feat: add SettingsRepository with settings migration
```

---

### Task 5: Create database initialization module

**Files:**
- Create: `src/db/init.ts`

This module ties together Database + VFS + migrations for the app's main database instance.

**Step 1: Implement init module**

```typescript
// src/db/init.ts
import { Database } from './Database'
import { runMigrations } from './migrations'
import { migration as settingsMigration } from './migrations/001_settings'
import { SettingsRepository } from './repositories/SettingsRepository'

// All migrations in order — add new ones here as the schema grows.
const allMigrations = [settingsMigration]

let database: Database | null = null
let settingsRepository: SettingsRepository | null = null

export async function initDatabase(): Promise<void> {
  database = new Database()
  // In browser with OPFS, pass a file path. In tests, omit for in-memory.
  await database.init('moneytracker.db')
  await runMigrations(database, allMigrations)
  settingsRepository = new SettingsRepository(database)
}

export function getDatabase(): Database {
  if (!database) throw new Error('Database not initialized. Call initDatabase() first.')
  return database
}

export function getSettingsRepository(): SettingsRepository {
  if (!settingsRepository) throw new Error('Database not initialized. Call initDatabase() first.')
  return settingsRepository
}
```

> **Note:** This module uses module-level state for the singleton instance. This is fine for the app's main database. The `Database` class itself remains instantiable for tests and future sync use.

**Step 2: Commit**

```
feat: add database initialization module
```

---

### Task 6: Wire Database.init() with OPFS VFS for browser

**Files:**
- Modify: `src/db/Database.ts`

**Step 1: Add OPFS VFS support to Database**

Update `Database.init()` to accept an options object and optionally register OPFSCoopSyncVFS:

```typescript
// Add to Database.ts

import { OPFSCoopSyncVFS } from 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js'

export interface DatabaseOptions {
  filePath?: string       // OPFS file path. Omit for in-memory.
  useOPFS?: boolean       // Register OPFS VFS. Default: false (in-memory for tests).
}

// Update init():
async init(options: DatabaseOptions = {}): Promise<void> {
  const module = await SQLiteESMFactory()
  this.sqlite3 = SQLite.Factory(module)

  if (options.useOPFS) {
    const vfs = await OPFSCoopSyncVFS.create('opfs-coop', module)
    this.sqlite3.vfs_register(vfs, true)
  }

  const filePath = options.filePath ?? ':memory:'
  this.db = await this.sqlite3.open_v2(filePath)
}
```

Update `src/db/init.ts` to pass `{ filePath: 'moneytracker.db', useOPFS: true }`.

Update tests to use `await db.init()` (no args = in-memory, no OPFS — keeps tests fast and environment-independent).

**Step 2: Run all db tests**

Run: `npx vitest run src/db/`
Expected: All tests PASS (they use in-memory mode, no OPFS needed).

**Step 3: Commit**

```
feat: add OPFS VFS support to Database class
```

---

### Task 7: Migrate layout store to write-through cache

**Files:**
- Modify: `src/stores/layout.ts`
- Modify: `src/stores/__tests__/layout.spec.ts`

**Step 1: Update the layout store**

Refactor `useLayoutStore` to:
1. Add an `async hydrate()` action that loads settings from SettingsRepository
2. Add setter actions that write through to SettingsRepository, then update refs
3. Keep existing computed properties unchanged

```typescript
// src/stores/layout.ts
import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { getSettingsRepository } from '@/db/init'

export type NavPosition = 'auto' | 'top' | 'bottom' | 'left' | 'right'
export type CollapseMode = 'always-collapsed' | 'opens-on-hover' | 'always-expanded'

const MOBILE_BREAKPOINT = 768

export const useLayoutStore = defineStore('layout', () => {
  const navPosition = ref<NavPosition>('auto')
  const collapseMode = ref<CollapseMode>('opens-on-hover')
  const isTemporarilyToggled = ref(false)

  const navItems = ref([
    { label: 'Home', icon: 'pi pi-home', route: '/' },
    { label: 'Page Two', icon: 'pi pi-file', route: '/page-two' },
    { label: 'About', icon: 'pi pi-info-circle', route: '/about' },
  ])

  /** Load persisted settings from SQLite. Call once after DB init. */
  async function hydrate(): Promise<void> {
    const repo = getSettingsRepository()
    const storedNavPos = await repo.get<NavPosition>('layout.navPosition')
    if (storedNavPos) navPosition.value = storedNavPos
    const storedCollapse = await repo.get<CollapseMode>('layout.collapseMode')
    if (storedCollapse) collapseMode.value = storedCollapse
  }

  async function setNavPosition(value: NavPosition): Promise<void> {
    const repo = getSettingsRepository()
    await repo.set('layout.navPosition', value)
    navPosition.value = value
  }

  async function setCollapseMode(value: CollapseMode): Promise<void> {
    const repo = getSettingsRepository()
    await repo.set('layout.collapseMode', value)
    collapseMode.value = value
  }

  function effectivePosition(windowWidth: number): Exclude<NavPosition, 'auto'> {
    if (navPosition.value !== 'auto') {
      return navPosition.value
    }
    return windowWidth >= MOBILE_BREAKPOINT ? 'left' : 'top'
  }

  const isVertical = computed(() => {
    return navPosition.value === 'left' || navPosition.value === 'right'
  })

  return {
    navPosition,
    collapseMode,
    isTemporarilyToggled,
    navItems,
    hydrate,
    setNavPosition,
    setCollapseMode,
    effectivePosition,
    isVertical,
  }
})
```

**Step 2: Update tests**

The existing tests use direct `store.navPosition = ...` assignment. Update them to use the new setter actions where persistence behavior is being tested, and add new tests for hydrate/persistence. For tests that only check computed behavior (like `effectivePosition`, `isVertical`), direct ref assignment is still fine.

```typescript
// Add to existing test file: src/stores/__tests__/layout.spec.ts

// Mock the db/init module so tests don't need a real database
vi.mock('@/db/init', () => {
  const store = new Map<string, unknown>()
  return {
    getSettingsRepository: () => ({
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: unknown) => { store.set(key, value) },
      getAll: async () => Object.fromEntries(store),
      delete: async (key: string) => { store.delete(key) },
    }),
  }
})

// Add new test cases:
it('hydrate() loads persisted navPosition', async () => {
  const { getSettingsRepository } = await import('@/db/init')
  await getSettingsRepository().set('layout.navPosition', 'right')
  const store = useLayoutStore()
  await store.hydrate()
  expect(store.navPosition).toBe('right')
})

it('setNavPosition() persists and updates ref', async () => {
  const store = useLayoutStore()
  await store.setNavPosition('bottom')
  expect(store.navPosition).toBe('bottom')
  const { getSettingsRepository } = await import('@/db/init')
  expect(await getSettingsRepository().get('layout.navPosition')).toBe('bottom')
})
```

**Step 3: Run tests**

Run: `npx vitest run src/stores/__tests__/layout.spec.ts`
Expected: All tests PASS.

**Step 4: Commit**

```
feat: migrate layout store to write-through SQLite persistence
```

---

### Task 8: Update main.ts initialization flow

**Files:**
- Modify: `src/main.ts`

**Step 1: Wire up Database init before Vue mount**

```typescript
// src/main.ts
import './assets/main.css'
import 'primeicons/primeicons.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'

import App from './App.vue'
import router from './router'
import { initDatabase } from './db/init'
import { useLayoutStore } from './stores/layout'

async function bootstrap(): Promise<void> {
  // 1. Initialize database (WASM load + OPFS + migrations)
  await initDatabase()

  // 2. Create Vue app and Pinia
  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)
  app.use(router)
  app.use(PrimeVue, {
    theme: {
      preset: Aura,
      options: {
        darkModeSelector: '.dark',
      },
    },
  })

  // 3. Hydrate stores from SQLite
  const layoutStore = useLayoutStore()
  await layoutStore.hydrate()

  // 4. Mount — UI only appears after data is ready
  app.mount('#app')
}

bootstrap()
```

**Step 2: Verify the app starts**

Run: `npm run dev`
Expected: App loads, settings page works. Changing nav position persists across page reloads.

**Step 3: Commit**

```
feat: wire database init into app bootstrap
```

---

### Task 9: Update SettingsView to use store actions

**Files:**
- Modify: `src/views/SettingsView.vue`

**Step 1: Replace direct ref assignments with store actions**

In `SettingsView.vue`, change:

```typescript
// Before:
function onNavPositionChange() {
  if (selectedNavPosition.value) {
    layoutStore.navPosition = selectedNavPosition.value.value
  }
}

// After:
async function onNavPositionChange() {
  if (selectedNavPosition.value) {
    await layoutStore.setNavPosition(selectedNavPosition.value.value)
  }
}
```

Same for `onCollapseModeChange`:

```typescript
async function onCollapseModeChange() {
  if (selectedCollapseMode.value) {
    await layoutStore.setCollapseMode(selectedCollapseMode.value.value)
  }
}
```

**Step 2: Manually test persistence**

Run: `npm run dev`
1. Open Settings, change nav position to "Right"
2. Reload the page
3. Expected: Nav is still on the right. Settings dropdown shows "Right".

**Step 3: Commit**

```
feat: persist layout settings through write-through SQLite cache
```

---

### Task 10: Run full test suite and verify build

**Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: All tests PASS.

**Step 2: Run type check**

Run: `npm run type-check`
Expected: No errors.

**Step 3: Run lint**

Run: `npm run lint`
Expected: No errors (or only pre-existing ones).

**Step 4: Run build**

Run: `npm run build`
Expected: Build succeeds. Check that wa-sqlite WASM is included in dist.

**Step 5: Commit any fixes**

If any fixes were needed:
```
fix: resolve lint/type/build issues from persistence layer
```
