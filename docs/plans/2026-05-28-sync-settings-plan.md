# Sync Settings — Device Name, Status Surface, and Provider Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the localStorage split, sync-settings composable, and Settings UI described in `docs/plans/2026-05-27-sync-settings-design.md`, plus rename the `deviceId` field in the existing sync core to `deviceName`.

**Architecture:** Replace the single-file `src/sync/localState.ts` with a `src/sync/localState/` directory of focused modules (one shared `storage.ts` helper + one file per concern + a barrel `index.ts`). Add a new `useSyncSettings` composable that reads from `localState` and lazily computes the current local DB hash via an injected codec. Append three sections (This device, Sync status, Sync provider) to `SettingsView.vue`. Wire a `DatabaseCodec` singleton slot through `src/db/init.ts` matching the existing `getDatabase` / `getSettingsRepository` pattern — populated by the future External-sync plan, `null` for now.

**Tech Stack:** TypeScript, Vue 3 Composition API, PrimeVue (`InputText`, `Password`, `RadioButton`, `Divider`), Tailwind CSS v4, Vitest. No new dependencies.

**Out of scope** — handled by the External-sync plan:
- Implementing a real `DatabaseCodec` (the singleton slot stays `null`).
- Implementing a real `SyncProvider` and the app-launch fetch that populates `lastFetchedRemoteSnapshot` (the slot stays empty, so Settings will read "no remote connection").
- A "Sync now" button.
- Actually instantiating a provider from the stored credentials.

---

## File Structure

```
src/sync/
  localState.ts                            ← DELETE
  localState/                              ← NEW directory
    index.ts                               ← barrel; preserves `from './localState'` import path
    storage.ts                             ← jsonStore / nullableJsonStore / stringStore helpers
    deviceName.ts                          ← device-name identity
    remoteSnapshots.ts                     ← lastKnownRemoteState + lastFetchedRemoteSnapshot
    providerConfig.ts                      ← provider types + load/save + EMPTY_PROVIDER_CONFIG
  syncOrchestrator.ts                      ← rename deviceId → deviceName in SyncDeps
  types.ts                                 ← comment update on `device` field
  __tests__/
    localState.spec.ts                     ← DELETE (replaced by per-module tests)
    localState/
      storage.spec.ts                      ← NEW
      deviceName.spec.ts                   ← NEW
      remoteSnapshots.spec.ts              ← NEW
      providerConfig.spec.ts               ← NEW
    syncOrchestrator.spec.ts               ← rename identifier literals

src/db/init.ts                             ← add DatabaseCodec singleton slot

src/views/
  SettingsView.vue                         ← three new Divider sections
  useSyncSettings.ts                       ← NEW composable
  __tests__/
    useSyncSettings.spec.ts                ← NEW

TASKS.md                                   ← move bullet to Done when landed
```

---

## Conventions for this plan

- All sync state tests are `src/sync/__tests__/localState/<name>.spec.ts`.
- Run a single spec with `npx vitest run <path-to-spec>`.
- `Database` operations must be `await`ed one at a time — wa-sqlite's Asyncify build cannot handle concurrent calls on one connection (see `CLAUDE.md`). Never `Promise.all` two DB calls.
- localStorage keys are namespaced `moneytracker.sync.<key>`; the `storage.ts` helper bakes the prefix in.
- Vue composables go in `src/views/` next to the `.vue` file that uses them, matching the existing `useSettingsOptions.ts` placement.
- Tests for the composable call it directly with injected fakes — no Vue component mounting needed because the composable uses only `ref`/`computed` (no lifecycle hooks).
- Commit at the end of each task with a `feat:` / `test:` / `refactor:` conventional-commit message.

---

### Task 1: Shared storage helper module

**Files:**
- Create: `src/sync/localState/storage.ts`
- Test: `src/sync/__tests__/localState/storage.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/localState/storage.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { jsonStore, nullableJsonStore, stringStore } from '../../localState/storage'

describe('storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('stringStore', () => {
    it('returns null when nothing is stored', () => {
      const s = stringStore('s1')
      expect(s.load()).toBeNull()
    })

    it('round-trips a string and prefixes the key with moneytracker.sync.', () => {
      const s = stringStore('s2')
      s.save('hello')
      expect(s.load()).toBe('hello')
      expect(localStorage.getItem('moneytracker.sync.s2')).toBe('hello')
    })

    it('clears the stored value', () => {
      const s = stringStore('s3')
      s.save('x')
      s.clear()
      expect(s.load()).toBeNull()
    })
  })

  describe('nullableJsonStore', () => {
    interface Snap { who: string; when: string }

    it('returns null when nothing is stored', () => {
      const s = nullableJsonStore<Snap>('n1')
      expect(s.load()).toBeNull()
    })

    it('round-trips a JSON value', () => {
      const s = nullableJsonStore<Snap>('n2')
      s.save({ who: 'a', when: 'b' })
      expect(s.load()).toEqual({ who: 'a', when: 'b' })
    })

    it('save(null) clears the slot so subsequent loads return null', () => {
      const s = nullableJsonStore<Snap>('n3')
      s.save({ who: 'a', when: 'b' })
      s.save(null)
      expect(s.load()).toBeNull()
    })

    it('returns null when the stored JSON is malformed', () => {
      localStorage.setItem('moneytracker.sync.n4', 'not json')
      const s = nullableJsonStore<Snap>('n4')
      expect(s.load()).toBeNull()
    })
  })

  describe('jsonStore', () => {
    interface Cfg { active: string; supabase: { url: string; key: string } }
    const DEFAULT: Cfg = { active: 'none', supabase: { url: '', key: '' } }

    it('returns the default when nothing is stored', () => {
      const s = jsonStore<Cfg>('j1', DEFAULT)
      expect(s.load()).toEqual(DEFAULT)
    })

    it('round-trips a full value', () => {
      const s = jsonStore<Cfg>('j2', DEFAULT)
      const value: Cfg = { active: 'supabase', supabase: { url: 'u', key: 'k' } }
      s.save(value)
      expect(s.load()).toEqual(value)
    })

    it('merges a partial stored value over the default (forward compatibility)', () => {
      // Simulates an older app version writing `{active: "supabase"}` without
      // the `supabase` sub-object that we added in this release. The reader
      // should fill the missing field from the default rather than crashing.
      localStorage.setItem('moneytracker.sync.j3', JSON.stringify({ active: 'supabase' }))
      const s = jsonStore<Cfg>('j3', DEFAULT)
      expect(s.load()).toEqual({ active: 'supabase', supabase: { url: '', key: '' } })
    })

    it('returns the default when the stored JSON is malformed', () => {
      localStorage.setItem('moneytracker.sync.j4', 'not json')
      const s = jsonStore<Cfg>('j4', DEFAULT)
      expect(s.load()).toEqual(DEFAULT)
    })

    it('returns a fresh copy of the default so callers cannot mutate it', () => {
      const s = jsonStore<Cfg>('j5', DEFAULT)
      const first = s.load()
      first.active = 'mutated'
      expect(s.load().active).toBe('none')
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/localState/storage.spec.ts`
Expected: FAIL — cannot resolve `../../localState/storage`.

- [ ] **Step 3: Implement `storage.ts`**

Create `src/sync/localState/storage.ts`:

```typescript
// Typed localStorage helpers shared by every sync-state slot in this
// directory. Three primitives, picked to cover all current needs:
//
//   stringStore        — short scalar identifiers (device name)
//   nullableJsonStore  — structured values that may legitimately be absent
//                        (snapshot caches before the first fetch)
//   jsonStore          — structured values with a sensible default
//                        (provider config). Performs a shallow default-merge
//                        on read so adding new fields to the type later does
//                        not break reads of values persisted by older builds.
//
// All three apply the "moneytracker.sync." key prefix automatically so the
// individual modules read like schema declarations.

const PREFIX = 'moneytracker.sync.'

function fullKey(key: string): string {
  return PREFIX + key
}

/** Plain-string slot. No JSON envelope — what you save is what you read back. */
export function stringStore(key: string): {
  load(): string | null
  save(value: string): void
  clear(): void
} {
  const k = fullKey(key)
  return {
    load: () => localStorage.getItem(k),
    save: (value) => {
      localStorage.setItem(k, value)
    },
    clear: () => {
      localStorage.removeItem(k)
    },
  }
}

/**
 * JSON slot that may legitimately be empty. `load()` returns null when nothing
 * has been stored or when the stored payload fails to parse. `save(null)`
 * clears the slot, so callers can persist absence directly.
 */
export function nullableJsonStore<T>(key: string): {
  load(): T | null
  save(value: T | null): void
} {
  const k = fullKey(key)
  return {
    load: () => {
      const raw = localStorage.getItem(k)
      if (!raw) return null
      try {
        return JSON.parse(raw) as T
      } catch {
        return null
      }
    },
    save: (value) => {
      if (value === null) {
        localStorage.removeItem(k)
      } else {
        localStorage.setItem(k, JSON.stringify(value))
      }
    },
  }
}

/**
 * JSON slot that always resolves to a value of T, merging a stored partial
 * over the supplied `defaultValue`. The merge is shallow — sufficient for the
 * provider-config use case where missing top-level fields are the realistic
 * forward-compatibility concern. Each `load()` returns a fresh copy so that
 * mutating the result cannot leak into the default or into other readers.
 */
export function jsonStore<T extends object>(
  key: string,
  defaultValue: T,
): {
  load(): T
  save(value: T): void
} {
  const k = fullKey(key)
  return {
    load: () => {
      const raw = localStorage.getItem(k)
      if (!raw) return { ...defaultValue }
      try {
        return { ...defaultValue, ...(JSON.parse(raw) as Partial<T>) }
      } catch {
        return { ...defaultValue }
      }
    },
    save: (value) => {
      localStorage.setItem(k, JSON.stringify(value))
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/localState/storage.spec.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/localState/storage.ts src/sync/__tests__/localState/storage.spec.ts
git commit -m "feat: add shared localStorage helpers for sync state"
```

---

### Task 2: Device name module

**Files:**
- Create: `src/sync/localState/deviceName.ts`
- Test: `src/sync/__tests__/localState/deviceName.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/localState/deviceName.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getDeviceName,
  setDeviceName,
  defaultDeviceName,
  parseUserAgent,
} from '../../localState/deviceName'

describe('parseUserAgent', () => {
  it('recognises Chrome on Windows', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    expect(parseUserAgent(ua)).toBe('Chrome on Windows')
  })

  it('recognises Firefox on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
    expect(parseUserAgent(ua)).toBe('Firefox on Linux')
  })

  it('recognises Safari on macOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
    expect(parseUserAgent(ua)).toBe('Safari on macOS')
  })

  it('recognises Edge over Chrome (Edg/ token wins)', () => {
    // Edge UA also contains "Chrome/" so the Edg/ check must come first.
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
    expect(parseUserAgent(ua)).toBe('Edge on Windows')
  })

  it('recognises Chrome on Android', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
    expect(parseUserAgent(ua)).toBe('Chrome on Android')
  })

  it('returns a sensible fallback for an unrecognised UA', () => {
    expect(parseUserAgent('something weird')).toBe('Unknown browser on Unknown OS')
  })
})

describe('defaultDeviceName', () => {
  it('produces "<browser> on <os> · <8 hex chars>"', () => {
    expect(defaultDeviceName()).toMatch(/^.+ on .+ · [0-9a-f]{8}$/)
  })

  it('produces a different random suffix on each call', () => {
    const a = defaultDeviceName()
    const b = defaultDeviceName()
    expect(a).not.toBe(b)
  })
})

describe('getDeviceName / setDeviceName', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('mints, persists, and returns a default on first call', () => {
    const first = getDeviceName()
    expect(first).toMatch(/^.+ on .+ · [0-9a-f]{8}$/)
    // Subsequent calls return the same persisted value — random suffix is stable.
    expect(getDeviceName()).toBe(first)
  })

  it('overwrites with setDeviceName and reads the new value back', () => {
    getDeviceName() // mint a default
    setDeviceName('My laptop')
    expect(getDeviceName()).toBe('My laptop')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/localState/deviceName.spec.ts`
Expected: FAIL — cannot resolve `../../localState/deviceName`.

- [ ] **Step 3: Implement `deviceName.ts`**

Create `src/sync/localState/deviceName.ts`:

```typescript
import { stringStore } from './storage'

// The device name is the sync identity: it is what `SyncMetadata.device` and
// `RemoteState.device` carry to every other device. Two design choices to
// note for future readers:
//
//  1. We deliberately use a human-readable name instead of an opaque UUID so
//     Settings can display "Office iMac" instead of "019432bc-…". The trade-off
//     is documented in docs/plans/2026-05-27-sync-settings-design.md:
//     renaming triggers one harmless re-merge; un-renamed devices rely on the
//     8-char random suffix to stay distinguishable.
//
//  2. Identity lives in localStorage, not in the SQLite database, because the
//     whole database is uploaded as one blob — anything inside it would be
//     copied to every other device.

const slot = stringStore('deviceName')

/** Returns the device name, minting and persisting a default on first call. */
export function getDeviceName(): string {
  let name = slot.load()
  if (!name) {
    name = defaultDeviceName()
    slot.save(name)
  }
  return name
}

/** Overwrites the stored device name. The change is visible to `getDeviceName`
 *  on the next call. */
export function setDeviceName(name: string): void {
  slot.save(name)
}

/** Builds a default device name. Exported for testing; production code should
 *  call `getDeviceName()` which persists the result. */
export function defaultDeviceName(): string {
  // navigator.userAgent is universally available in browsers and jsdom; the
  // empty fallback only matters for environments that strip it.
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return `${parseUserAgent(ua)} · ${randomSuffix()}`
}

/** Pure function — exported for testing. */
export function parseUserAgent(ua: string): string {
  return `${detectBrowser(ua)} on ${detectOS(ua)}`
}

function detectBrowser(ua: string): string {
  // Edge embeds "Chrome/" too, so its check must come first. Same trick for
  // any future Chromium-derivative we add (Opera GX, Brave, …).
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('Firefox/')) return 'Firefox'
  if (ua.includes('Chrome/')) return 'Chrome'
  if (ua.includes('Safari/')) return 'Safari'
  return 'Unknown browser'
}

function detectOS(ua: string): string {
  // Android UAs also contain "Linux", so the Android check has to come first.
  if (ua.includes('Android')) return 'Android'
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'
  if (ua.includes('Windows')) return 'Windows'
  if (ua.includes('Macintosh') || ua.includes('Mac OS')) return 'macOS'
  if (ua.includes('Linux')) return 'Linux'
  return 'Unknown OS'
}

/** 8 lowercase hex characters drawn from crypto.getRandomValues — 32 bits of
 *  entropy, enough to keep two un-renamed devices apart for a single household. */
function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/localState/deviceName.spec.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/localState/deviceName.ts src/sync/__tests__/localState/deviceName.spec.ts
git commit -m "feat: add device-name identity module with UA-derived default"
```

---

### Task 3: Remote snapshots module

**Files:**
- Create: `src/sync/localState/remoteSnapshots.ts`
- Test: `src/sync/__tests__/localState/remoteSnapshots.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/localState/remoteSnapshots.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import type { RemoteState, SyncMetadata } from '../../types'
import {
  loadLastKnownRemoteState,
  saveLastKnownRemoteState,
  loadLastFetchedRemoteSnapshot,
  saveLastFetchedRemoteSnapshot,
} from '../../localState/remoteSnapshots'

describe('remoteSnapshots', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('lastKnownRemoteState', () => {
    it('returns null when no remote state has been saved', () => {
      expect(loadLastKnownRemoteState()).toBeNull()
    })

    it('round-trips the last known remote state', () => {
      const state: RemoteState = {
        device: 'My laptop · a3f4b7e1',
        uploadedAtUtc: '2026-05-22T10:00:00.000Z',
        hash: 'abc',
      }
      saveLastKnownRemoteState(state)
      expect(loadLastKnownRemoteState()).toEqual(state)
    })
  })

  describe('lastFetchedRemoteSnapshot', () => {
    it('returns null when no snapshot has been cached', () => {
      expect(loadLastFetchedRemoteSnapshot()).toBeNull()
    })

    it('round-trips a snapshot', () => {
      const snap: SyncMetadata = {
        device: 'Office iMac · 7b22ee01',
        uploadedAtUtc: '2026-05-22T16:10:00.000Z',
        hash: 'd12af4',
        migrationVersion: 2,
      }
      saveLastFetchedRemoteSnapshot(snap)
      expect(loadLastFetchedRemoteSnapshot()).toEqual(snap)
    })

    it('save(null) clears the cache so loaders see "no remote connection" again', () => {
      const snap: SyncMetadata = {
        device: 'x',
        uploadedAtUtc: '2026-05-22T16:10:00.000Z',
        hash: 'h',
        migrationVersion: 2,
      }
      saveLastFetchedRemoteSnapshot(snap)
      saveLastFetchedRemoteSnapshot(null)
      expect(loadLastFetchedRemoteSnapshot()).toBeNull()
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/localState/remoteSnapshots.spec.ts`
Expected: FAIL — cannot resolve `../../localState/remoteSnapshots`.

- [ ] **Step 3: Implement `remoteSnapshots.ts`**

Create `src/sync/localState/remoteSnapshots.ts`:

```typescript
import type { RemoteState, SyncMetadata } from '../types'
import { nullableJsonStore } from './storage'

// Two snapshot slots, both produced by the sync subsystem and consumed by the
// Settings UI as read-only displays:
//
//  - lastKnownRemoteState     — the orchestrator writes this after every
//                               successful sync. Used by the merge cutoff and
//                               displayed in Settings as "Last sync (this device)".
//
//  - lastFetchedRemoteSnapshot — populated by the future app-launch fetch
//                               (deferred to the External-sync plan). Settings
//                               reads only the cache; it never triggers a
//                               network call. Until the fetch is wired in, the
//                               slot stays empty and Settings shows
//                               "no remote connection".

const lastKnown = nullableJsonStore<RemoteState>('lastKnownRemoteState')
const lastFetched = nullableJsonStore<SyncMetadata>('lastFetchedRemoteSnapshot')

/** The remote state recorded at the last successful sync, or null if never synced. */
export function loadLastKnownRemoteState(): RemoteState | null {
  return lastKnown.load()
}

/** Persists the remote state to compare against on the next sync. */
export function saveLastKnownRemoteState(state: RemoteState): void {
  lastKnown.save(state)
}

/** The most recent remote metadata fetched outside of a sync, or null when none. */
export function loadLastFetchedRemoteSnapshot(): SyncMetadata | null {
  return lastFetched.load()
}

/** Persists a fetched remote snapshot for the Settings UI. Pass null to clear. */
export function saveLastFetchedRemoteSnapshot(snapshot: SyncMetadata | null): void {
  lastFetched.save(snapshot)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/localState/remoteSnapshots.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/localState/remoteSnapshots.ts src/sync/__tests__/localState/remoteSnapshots.spec.ts
git commit -m "feat: add remote-snapshot slots for sync status display"
```

---

### Task 4: Provider config module

**Files:**
- Create: `src/sync/localState/providerConfig.ts`
- Test: `src/sync/__tests__/localState/providerConfig.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/sync/__tests__/localState/providerConfig.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadProviderConfig,
  saveProviderConfig,
  EMPTY_PROVIDER_CONFIG,
  type ProviderConfig,
} from '../../localState/providerConfig'

describe('providerConfig', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns EMPTY_PROVIDER_CONFIG when nothing is stored', () => {
    expect(loadProviderConfig()).toEqual(EMPTY_PROVIDER_CONFIG)
  })

  it('EMPTY_PROVIDER_CONFIG has sensible defaults', () => {
    expect(EMPTY_PROVIDER_CONFIG.active).toBe('none')
    expect(EMPTY_PROVIDER_CONFIG.supabase.bucket).toBe('moneytracker')
    expect(EMPTY_PROVIDER_CONFIG.s3.objectKey).toBe('moneytracker.sqlite')
    expect(EMPTY_PROVIDER_CONFIG.github.branch).toBe('main')
    expect(EMPTY_PROVIDER_CONFIG.github.path).toBe('moneytracker.sqlite')
  })

  it('round-trips a fully populated config', () => {
    const cfg: ProviderConfig = {
      active: 's3',
      supabase: { url: 'https://x.supabase.co', anonKey: 'sb-key', bucket: 'mt' },
      s3: {
        endpoint: 'https://s3',
        region: 'auto',
        accessKeyId: 'AK',
        secretKey: 'SK',
        bucket: 'mt',
        objectKey: 'db.sqlite',
      },
      github: { repo: 'me/mt', branch: 'main', path: 'db.sqlite', token: 'ghp_x' },
    }
    saveProviderConfig(cfg)
    expect(loadProviderConfig()).toEqual(cfg)
  })

  it('merges a partial stored config over EMPTY_PROVIDER_CONFIG (forward compat)', () => {
    // Simulates a stored payload from a future or past build that only set
    // `active` and a partial supabase block. The load must fill in the rest
    // from the empty default so a missing field never throws downstream.
    localStorage.setItem(
      'moneytracker.sync.providerConfig',
      JSON.stringify({ active: 'supabase', supabase: { url: 'u', anonKey: 'k', bucket: 'b' } }),
    )
    const cfg = loadProviderConfig()
    expect(cfg.active).toBe('supabase')
    expect(cfg.supabase).toEqual({ url: 'u', anonKey: 'k', bucket: 'b' })
    // The unset blocks fall back to the empty defaults.
    expect(cfg.s3).toEqual(EMPTY_PROVIDER_CONFIG.s3)
    expect(cfg.github).toEqual(EMPTY_PROVIDER_CONFIG.github)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/__tests__/localState/providerConfig.spec.ts`
Expected: FAIL — cannot resolve `../../localState/providerConfig`.

- [ ] **Step 3: Implement `providerConfig.ts`**

Create `src/sync/localState/providerConfig.ts`:

```typescript
import { jsonStore } from './storage'

// Sync-provider configuration. All three credential blocks are persisted
// regardless of which one is active, so the user can switch providers
// without losing settings. The realistic threat against tokens stored here
// is XSS, which already exfiltrates the entire SQLite database, so at-rest
// encryption of these fields would not raise the bar. See the design doc
// (docs/plans/2026-05-27-sync-settings-design.md, "Secrets stored
// plaintext in localStorage") for the full reasoning.

export type SyncProviderKind = 'none' | 'supabase' | 's3' | 'github'

export interface SupabaseConfig {
  url: string
  anonKey: string
  bucket: string
}

export interface S3Config {
  endpoint: string
  region: string
  accessKeyId: string
  secretKey: string
  bucket: string
  objectKey: string
}

export interface GitHubConfig {
  repo: string
  branch: string
  path: string
  token: string
}

export interface ProviderConfig {
  active: SyncProviderKind
  supabase: SupabaseConfig
  s3: S3Config
  github: GitHubConfig
}

export const EMPTY_PROVIDER_CONFIG: ProviderConfig = {
  active: 'none',
  supabase: { url: '', anonKey: '', bucket: 'moneytracker' },
  s3: {
    endpoint: '',
    region: 'auto',
    accessKeyId: '',
    secretKey: '',
    bucket: 'moneytracker',
    objectKey: 'moneytracker.sqlite',
  },
  github: { repo: '', branch: 'main', path: 'moneytracker.sqlite', token: '' },
}

const slot = jsonStore<ProviderConfig>('providerConfig', EMPTY_PROVIDER_CONFIG)

export function loadProviderConfig(): ProviderConfig {
  return slot.load()
}

export function saveProviderConfig(config: ProviderConfig): void {
  slot.save(config)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/__tests__/localState/providerConfig.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/localState/providerConfig.ts src/sync/__tests__/localState/providerConfig.spec.ts
git commit -m "feat: add provider-config types and storage"
```

---

### Task 5: Barrel + remove old single-file localState

**Files:**
- Create: `src/sync/localState/index.ts`
- Delete: `src/sync/localState.ts`
- Delete: `src/sync/__tests__/localState.spec.ts`

- [ ] **Step 1: Create the barrel**

Create `src/sync/localState/index.ts`:

```typescript
// Barrel re-exports for the sync-state directory. Keeps the public import
// surface `from './localState'` (or '../localState' from __tests__) unchanged
// so the rest of the sync core does not need to know about the split.

export * from './deviceName'
export * from './remoteSnapshots'
export * from './providerConfig'
// Storage helpers are intentionally NOT re-exported — they are an internal
// implementation detail of this directory.
```

- [ ] **Step 2: Delete the old single-file module and its test**

Run:

```bash
git rm src/sync/localState.ts src/sync/__tests__/localState.spec.ts
```

- [ ] **Step 3: Verify nothing else still imports the old `getDeviceId`**

Run: `npx grep -rn "getDeviceId" src/`
Expected: no matches.

Run: `npx grep -rn "DEVICE_ID_KEY\|REMOTE_STATE_KEY" src/`
Expected: no matches.

(On Windows PowerShell, use `Select-String -Path src\* -Pattern 'getDeviceId' -Recurse` if `grep` is not on PATH.)

- [ ] **Step 4: Run the whole sync test suite to confirm the import path still resolves**

Run: `npx vitest run src/sync`
Expected: 4 new localState specs PASS; the existing sync core specs still PASS (`syncOrchestrator.spec.ts` still imports nothing from `localState` so it is unaffected; the merge / row / schema / fakes specs are independent).

If the syncOrchestrator spec already breaks here, that is the rename work captured by Task 6 — proceed to that task before commit.

- [ ] **Step 5: Commit**

```bash
git add src/sync/localState/index.ts
git commit -m "refactor: split sync localState into per-concern modules behind a barrel"
```

---

### Task 6: Rename `deviceId` → `deviceName` in the sync orchestrator

**Files:**
- Modify: `src/sync/syncOrchestrator.ts`
- Modify: `src/sync/types.ts`
- Modify: `src/sync/__tests__/syncOrchestrator.spec.ts`

The merge engine and `decideSync` treat the field as an opaque string, so this is a pure rename of identifiers and string literals — no algorithmic change.

- [ ] **Step 1: Update the comment on `SyncMetadata.device` in `types.ts`**

Edit `src/sync/types.ts`:

Replace the JSDoc on the `device` field of `SyncMetadata` and on `RemoteState.device`:

```typescript
/** Metadata stored alongside the remote database blob. */
export interface SyncMetadata {
  /** Device name of the device that produced this upload. Stable identity
   *  for the sync algorithm; carries through to other devices as the value
   *  shown in their Settings "Uploaded by" rows. */
  device: string
  /** When the upload happened — ISO 8601 UTC. */
  uploadedAtUtc: string
  /** Hash of the uploaded database blob. */
  hash: string
  /** Schema (migration) version of the uploaded database. */
  migrationVersion: number
}

/** What a device recorded locally at its last successful sync. */
export interface RemoteState {
  /** Device name (matches `SyncMetadata.device` of the recorded upload). */
  device: string
  uploadedAtUtc: string
  hash: string
}
```

- [ ] **Step 2: Rename `deviceId` → `deviceName` in `SyncDeps` and `decideSync`**

Edit `src/sync/syncOrchestrator.ts`:

Replace the `decideSync` function:

```typescript
export function decideSync(
  localHash: string,
  remoteMeta: SyncMetadata,
  deviceName: string,
): SyncDecision {
  if (localHash === remoteMeta.hash) return 'none'
  if (remoteMeta.device === deviceName) return 'upload-local'
  return 'merge'
}
```

Replace the `SyncDeps` interface:

```typescript
/** Everything `runSync` needs, injected so the orchestrator stays testable. */
export interface SyncDeps {
  provider: SyncProvider
  codec: DatabaseCodec
  /** This device's identity, carried through to other devices in `SyncMetadata.device`. */
  deviceName: string
  /** Current time — injectable so tests are deterministic. */
  now: () => Date
  /** Brings a downloaded older-schema database up to the current schema. */
  migrate: (db: Database) => Promise<void>
  loadLastKnown: () => RemoteState | null
  saveLastKnown: (state: RemoteState) => void
}
```

Replace the two `deps.deviceId` references in `runSync` with `deps.deviceName`. The two sites are: the `stamp(hash)` builder (`device: deps.deviceName`) and the `decideSync(localHash, remoteMeta, deps.deviceName)` call.

- [ ] **Step 3: Update the orchestrator test identifiers**

Edit `src/sync/__tests__/syncOrchestrator.spec.ts`:

Replace the `deps` factory:

```typescript
function deps(provider: FakeSyncProvider) {
  const state: { lastKnown: import('../types').RemoteState | null } = { lastKnown: null }
  return {
    provider,
    codec: new FakeDatabaseCodec(),
    deviceName: 'dev-A',
    now: () => new Date('2026-05-22T12:00:00.000Z'),
    migrate: async () => {},
    loadLastKnown: () => state.lastKnown,
    saveLastKnown: (s: import('../types').RemoteState) => {
      state.lastKnown = s
    },
  }
}
```

The three `decideSync` test calls already pass string literals (`'dev-A'`, `'dev-B'`) — leave those as-is. The orchestrator-level tests pass the deps object, so the rename is invisible to them.

- [ ] **Step 4: Run the whole sync suite and type-check**

Run: `npx vitest run src/sync && npm run type-check`
Expected: every sync spec PASSES; `type-check` reports no errors. If type-check finds a stale `deviceId` reference anywhere else, fix it the same way (rename the field, keep the value).

- [ ] **Step 5: Commit**

```bash
git add src/sync/syncOrchestrator.ts src/sync/types.ts src/sync/__tests__/syncOrchestrator.spec.ts
git commit -m "refactor: rename deviceId to deviceName in sync orchestrator and SyncDeps"
```

---

### Task 7: Database codec singleton slot

**Files:**
- Modify: `src/db/init.ts`

This task plumbs a `DatabaseCodec` registration slot through `init.ts` so the Settings UI has a place to read it from. Until the External-sync plan registers a real codec, `getDatabaseCodec()` returns `null` and the "Current local database" row in Settings renders as "not available".

This matches the existing `init.ts` pattern (module-level singleton + getter that throws if uninitialized) — except this getter returns `null` instead of throwing, because the codec is legitimately absent today.

- [ ] **Step 1: Add the slot and accessors to `src/db/init.ts`**

Edit `src/db/init.ts`:

Add an import next to the existing imports:

```typescript
import type { DatabaseCodec } from '../sync/DatabaseCodec'
```

Add a module-level slot next to the other `let database = …` declarations:

```typescript
let databaseCodec: DatabaseCodec | null = null
```

Add the registration and accessor functions next to `getDatabase`:

```typescript
/**
 * Registers the codec used to export the local database to a syncable blob.
 * Called by the External-sync plan once a real codec is wired in. Until then
 * `getDatabaseCodec()` returns null and consumers must handle that.
 */
export function setDatabaseCodec(codec: DatabaseCodec | null): void {
  databaseCodec = codec
}

/** Returns the registered codec, or null when none has been registered yet. */
export function getDatabaseCodec(): DatabaseCodec | null {
  return databaseCodec
}
```

Extend `closeDatabase()` to also clear the codec slot so tests stay isolated:

```typescript
/** Closes the database and resets module-level singletons. Useful for testing. */
export async function closeDatabase(): Promise<void> {
  if (database) {
    await database.close()
  }
  database = null
  databaseCodec = null
  settingsRepository = null
  tagsRepository = null
  locationsRepository = null
  accountsRepository = null
  exchangeRatesRepository = null
  accountGroupingsRepository = null
  transactionsRepository = null
}
```

- [ ] **Step 2: Type-check**

Run: `npm run type-check`
Expected: no errors. No test is added here — the slot is exercised end-to-end by the composable test in Task 8.

- [ ] **Step 3: Commit**

```bash
git add src/db/init.ts
git commit -m "feat: add DatabaseCodec singleton slot for the sync-settings UI"
```

---

### Task 8: `useSyncSettings` composable

**Files:**
- Create: `src/views/useSyncSettings.ts`
- Test: `src/views/__tests__/useSyncSettings.spec.ts`

The composable is the seam between the Settings UI and the sync-state modules. It exposes reactive refs for the device name, the three displayed snapshots, the current-local hash (computed on demand), and the provider config — plus handlers that write through to localStorage on change.

Dependencies are passed in explicitly (Java/Go-style) rather than imported from `init.ts` inside the composable. This keeps testing trivial: the test calls `useSyncSettings({ db: null, codec: null })` or with fakes, with no module mocking required.

- [ ] **Step 1: Write the failing test**

Create `src/views/__tests__/useSyncSettings.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useSyncSettings } from '../useSyncSettings'
import type { Database } from '../../db/Database'
import type { DatabaseCodec } from '../../sync/DatabaseCodec'
import {
  saveLastKnownRemoteState,
  saveLastFetchedRemoteSnapshot,
  saveProviderConfig,
  EMPTY_PROVIDER_CONFIG,
  loadProviderConfig,
  getDeviceName,
} from '../../sync/localState'

// A minimal codec stub — only the two methods the composable uses.
function fakeCodec(blob: Blob, hash: string): DatabaseCodec {
  return {
    export: async () => blob,
    openFromBlob: async () => {
      throw new Error('not used here')
    },
    hash: async () => hash,
  }
}

// `null as unknown as Database` only goes through the composable when the
// codec is also null — exercised below in the "DB unavailable" test.
const NO_DB = null as unknown as Database | null

describe('useSyncSettings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('device name', () => {
    it('exposes the persisted device name and updates the underlying store on save', () => {
      const s = useSyncSettings({ db: NO_DB, codec: null })
      // Default minted on first read.
      expect(s.deviceName.value).toMatch(/^.+ on .+ · [0-9a-f]{8}$/)

      s.deviceName.value = 'My laptop'
      s.saveDeviceName()
      expect(getDeviceName()).toBe('My laptop')
    })
  })

  describe('last sync row', () => {
    it('reports "never" when no sync has happened', () => {
      const s = useSyncSettings({ db: NO_DB, codec: null })
      expect(s.lastKnownRemoteState.value).toBeNull()
    })

    it('returns the persisted lastKnownRemoteState', () => {
      saveLastKnownRemoteState({
        device: 'My laptop · a3f4b7e1',
        uploadedAtUtc: '2026-05-22T10:00:00.000Z',
        hash: 'abc',
      })
      const s = useSyncSettings({ db: NO_DB, codec: null })
      expect(s.lastKnownRemoteState.value).toEqual({
        device: 'My laptop · a3f4b7e1',
        uploadedAtUtc: '2026-05-22T10:00:00.000Z',
        hash: 'abc',
      })
    })
  })

  describe('current local DB row', () => {
    it('is null when no codec is available', async () => {
      const s = useSyncSettings({ db: NO_DB, codec: null })
      await s.recomputeLocalHash()
      expect(s.localHash.value).toBeNull()
      expect(s.localHashComputedAt.value).toBeNull()
    })

    it('computes the hash on demand and stores the computation time', async () => {
      const codec = fakeCodec(new Blob(['x']), 'cafef00d')
      const fakeDb = {} as Database // codec.export never touches the db in the fake
      const s = useSyncSettings({ db: fakeDb, codec })
      const before = Date.now()
      await s.recomputeLocalHash()
      expect(s.localHash.value).toBe('cafef00d')
      const at = s.localHashComputedAt.value
      expect(at).not.toBeNull()
      expect(at!.getTime()).toBeGreaterThanOrEqual(before)
    })
  })

  describe('last seen remote row', () => {
    it('reports null when no snapshot has been cached', () => {
      const s = useSyncSettings({ db: NO_DB, codec: null })
      expect(s.lastFetchedRemoteSnapshot.value).toBeNull()
    })

    it('returns the cached snapshot', () => {
      saveLastFetchedRemoteSnapshot({
        device: 'Office iMac · 7b22ee01',
        uploadedAtUtc: '2026-05-22T16:10:00.000Z',
        hash: 'd12af4',
        migrationVersion: 2,
      })
      const s = useSyncSettings({ db: NO_DB, codec: null })
      expect(s.lastFetchedRemoteSnapshot.value?.device).toBe('Office iMac · 7b22ee01')
    })
  })

  describe('provider config', () => {
    it('exposes EMPTY_PROVIDER_CONFIG when nothing is stored', () => {
      const s = useSyncSettings({ db: NO_DB, codec: null })
      expect(s.providerConfig.value).toEqual(EMPTY_PROVIDER_CONFIG)
    })

    it('saves edits to the underlying provider-config store', () => {
      const s = useSyncSettings({ db: NO_DB, codec: null })
      s.providerConfig.value.active = 's3'
      s.providerConfig.value.s3.bucket = 'my-bucket'
      s.saveProviderConfig()
      const reloaded = loadProviderConfig()
      expect(reloaded.active).toBe('s3')
      expect(reloaded.s3.bucket).toBe('my-bucket')
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/views/__tests__/useSyncSettings.spec.ts`
Expected: FAIL — cannot resolve `../useSyncSettings`.

- [ ] **Step 3: Implement `useSyncSettings.ts`**

Create `src/views/useSyncSettings.ts`:

```typescript
import { ref, type Ref } from 'vue'
import type { Database } from '@/db/Database'
import type { DatabaseCodec } from '@/sync/DatabaseCodec'
import {
  getDeviceName,
  setDeviceName,
  loadLastKnownRemoteState,
  loadLastFetchedRemoteSnapshot,
  loadProviderConfig,
  saveProviderConfig,
  type ProviderConfig,
} from '@/sync/localState'
import type { RemoteState, SyncMetadata } from '@/sync/types'

// Composable for the Sync sections of the Settings page. Owns the reactive
// state and the localStorage writes; the .vue file is presentation-only.
//
// Dependencies (database + codec) are passed in explicitly rather than read
// from a module-level singleton inside this function. Two reasons:
//   1. Tests stay trivial — just call useSyncSettings({db, codec}) with fakes.
//   2. The codec is legitimately absent today (the External-sync plan is what
//      registers a real one). Making absence visible in the call signature
//      forces callers to think about it.

export interface SyncSettingsDeps {
  /** Local database used to compute the current-local-DB hash. May be null
   *  when called from a non-db test fixture. */
  db: Database | null
  /** Codec used to export the db before hashing. Null until the External-sync
   *  plan registers one — when null, the "Current local DB" row reads as
   *  unavailable in the UI. */
  codec: DatabaseCodec | null
}

export interface SyncSettings {
  // Device name — editable.
  deviceName: Ref<string>
  saveDeviceName: () => void

  // Read-only displays.
  lastKnownRemoteState: Ref<RemoteState | null>
  lastFetchedRemoteSnapshot: Ref<SyncMetadata | null>

  // Computed on demand. `localHash` is null when the codec is unavailable
  // OR when recomputeLocalHash has not been called yet.
  localHash: Ref<string | null>
  localHashComputedAt: Ref<Date | null>
  recomputeLocalHash: () => Promise<void>

  // Provider config — editable through the reactive ref, persisted on save.
  providerConfig: Ref<ProviderConfig>
  saveProviderConfig: () => void
}

export function useSyncSettings(deps: SyncSettingsDeps): SyncSettings {
  const deviceName = ref(getDeviceName())
  const lastKnownRemoteState = ref(loadLastKnownRemoteState())
  const lastFetchedRemoteSnapshot = ref(loadLastFetchedRemoteSnapshot())
  const providerConfig = ref<ProviderConfig>(loadProviderConfig())

  const localHash = ref<string | null>(null)
  const localHashComputedAt = ref<Date | null>(null)

  function saveDeviceNameNow(): void {
    setDeviceName(deviceName.value)
  }

  function saveProviderConfigNow(): void {
    saveProviderConfig(providerConfig.value)
  }

  async function recomputeLocalHash(): Promise<void> {
    if (!deps.db || !deps.codec) {
      // Codec absent → External-sync plan has not landed yet. Leave the
      // row null so the UI can render "not available".
      localHash.value = null
      localHashComputedAt.value = null
      return
    }
    // Each call exports the database fresh. Cheap-ish for small DBs but
    // explicitly not run reactively on every keystroke — the composable
    // only computes when the caller asks for it (mount + Recompute button).
    const blob = await deps.codec.export(deps.db)
    localHash.value = await deps.codec.hash(blob)
    localHashComputedAt.value = new Date()
  }

  return {
    deviceName,
    saveDeviceName: saveDeviceNameNow,
    lastKnownRemoteState,
    lastFetchedRemoteSnapshot,
    localHash,
    localHashComputedAt,
    recomputeLocalHash,
    providerConfig,
    saveProviderConfig: saveProviderConfigNow,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/views/__tests__/useSyncSettings.spec.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/views/useSyncSettings.ts src/views/__tests__/useSyncSettings.spec.ts
git commit -m "feat: add useSyncSettings composable"
```

---

### Task 9: Settings view — three new sections

**Files:**
- Modify: `src/views/SettingsView.vue`

Adds **This device**, **Sync status**, and **Sync provider** sections to the existing Settings card, following the layout pattern already used by the Visual section.

This task has no automated test — the composable's behaviour is covered by Task 8, and the .vue file is presentation only. Verification is visual: load the dev server and inspect Settings.

- [ ] **Step 1: Replace the contents of `src/views/SettingsView.vue`**

Replace the file with:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import Card from 'primevue/card'
import Select from 'primevue/select'
import ToggleSwitch from 'primevue/toggleswitch'
import Divider from 'primevue/divider'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import RadioButton from 'primevue/radiobutton'
import Button from 'primevue/button'
import { useSettingsOptions } from './useSettingsOptions'
import { useSyncSettings } from './useSyncSettings'
import { getDatabase, getDatabaseCodec } from '@/db/init'

const {
  layoutStore,
  themePresetOptions,
  selectedPreset,
  onPresetChange,
  onDarkModeChange,
  navPositionOptions,
  selectedNavPosition,
  onNavPositionChange,
  collapseModeOptions,
  selectedCollapseMode,
  onCollapseModeChange,
  showCollapseMode,
} = useSettingsOptions()

// The codec is registered by the External-sync plan; for now it returns null
// and the "Current local database" row will render its "not available" state.
const sync = useSyncSettings({ db: getDatabase(), codec: getDatabaseCodec() })

// Show a short hash (first 8 chars) inline, full value as a tooltip via `title`.
function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—'
  return hash.length > 8 ? hash.slice(0, 8) + '…' : hash
}

function formatInstant(iso: string | null | undefined): string {
  if (!iso) return '—'
  // Display in the user's locale; the raw ISO string lives in the tooltip.
  return new Date(iso).toLocaleString()
}

const localHashMatchesLastSync = computed(() => {
  const local = sync.localHash.value
  const last = sync.lastKnownRemoteState.value?.hash
  return local !== null && last !== undefined && local === last
})
</script>

<template>
  <Card>
    <template #title>Settings</template>
    <template #content>
      <Divider align="left" type="solid">
        <b>Visual</b>
      </Divider>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="theme-preset">Theme preset</label>
          <Select
            id="theme-preset"
            v-model="selectedPreset"
            :options="themePresetOptions"
            optionLabel="name"
            @change="onPresetChange"
          />
        </div>
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="dark-mode">Dark mode</label>
          <ToggleSwitch
            id="dark-mode"
            v-model="layoutStore.isDark"
            @update:modelValue="onDarkModeChange"
          />
        </div>
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="nav-position">Nav position</label>
          <Select
            id="nav-position"
            v-model="selectedNavPosition"
            :options="navPositionOptions"
            optionLabel="name"
            @change="onNavPositionChange"
          />
        </div>
        <div
          v-if="showCollapseMode"
          class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1"
        >
          <label for="collapse-mode">Sidebar mode</label>
          <Select
            id="collapse-mode"
            v-model="selectedCollapseMode"
            :options="collapseModeOptions"
            optionLabel="name"
            @change="onCollapseModeChange"
          />
        </div>
      </div>

      <Divider align="left" type="solid">
        <b>This device</b>
      </Divider>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="device-name">Device name</label>
          <InputText
            id="device-name"
            v-model="sync.deviceName.value"
            class="sm:w-80"
            @blur="sync.saveDeviceName()"
          />
        </div>
        <p class="text-sm text-surface-500">
          Used to identify this device when syncing. Renaming it triggers one
          harmless re-merge on the next sync.
        </p>
      </div>

      <Divider align="left" type="solid">
        <b>Sync status</b>
      </Divider>
      <div class="flex flex-col gap-6">
        <!-- Last sync (this device) -->
        <div class="flex flex-col gap-1">
          <div class="font-medium">Last sync (this device)</div>
          <template v-if="sync.lastKnownRemoteState.value">
            <div class="flex justify-between text-sm">
              <span>When</span>
              <span :title="sync.lastKnownRemoteState.value.uploadedAtUtc">
                {{ formatInstant(sync.lastKnownRemoteState.value.uploadedAtUtc) }}
              </span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Uploaded by</span>
              <span>{{ sync.lastKnownRemoteState.value.device }}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Hash</span>
              <span :title="sync.lastKnownRemoteState.value.hash" class="font-mono">
                {{ shortHash(sync.lastKnownRemoteState.value.hash) }}
              </span>
            </div>
          </template>
          <div v-else class="text-sm text-surface-500">Never synced from this device.</div>
        </div>

        <!-- Current local database -->
        <div class="flex flex-col gap-1">
          <div class="flex justify-between items-center">
            <div class="font-medium">Current local database</div>
            <Button
              label="Recompute"
              severity="secondary"
              size="small"
              text
              @click="sync.recomputeLocalHash()"
            />
          </div>
          <template v-if="sync.localHash.value !== null">
            <div class="flex justify-between text-sm">
              <span>Hash</span>
              <span :title="sync.localHash.value" class="font-mono">
                {{ shortHash(sync.localHash.value) }}
                <span v-if="localHashMatchesLastSync" class="text-surface-500">
                  (matches last sync)
                </span>
              </span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Computed at</span>
              <span>{{ formatInstant(sync.localHashComputedAt.value?.toISOString()) }}</span>
            </div>
          </template>
          <div v-else class="text-sm text-surface-500">
            Not available — sync codec not yet registered. Click Recompute after the External-sync
            plan lands.
          </div>
        </div>

        <!-- Last seen remote -->
        <div class="flex flex-col gap-1">
          <div class="font-medium">Last seen remote</div>
          <template v-if="sync.lastFetchedRemoteSnapshot.value">
            <div class="flex justify-between text-sm">
              <span>When</span>
              <span :title="sync.lastFetchedRemoteSnapshot.value.uploadedAtUtc">
                {{ formatInstant(sync.lastFetchedRemoteSnapshot.value.uploadedAtUtc) }}
              </span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Uploaded by</span>
              <span>{{ sync.lastFetchedRemoteSnapshot.value.device }}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Hash</span>
              <span :title="sync.lastFetchedRemoteSnapshot.value.hash" class="font-mono">
                {{ shortHash(sync.lastFetchedRemoteSnapshot.value.hash) }}
              </span>
            </div>
          </template>
          <div v-else class="text-sm text-surface-500">No remote connection.</div>
        </div>
      </div>

      <Divider align="left" type="solid">
        <b>Sync provider</b>
      </Divider>
      <div class="flex flex-col gap-6">
        <!-- Active selector -->
        <div class="flex flex-wrap items-center gap-4">
          <span class="font-medium mr-2">Active:</span>
          <div class="flex items-center gap-2">
            <RadioButton
              v-model="sync.providerConfig.value.active"
              inputId="provider-none"
              value="none"
              @change="sync.saveProviderConfig()"
            />
            <label for="provider-none">None</label>
          </div>
          <div class="flex items-center gap-2">
            <RadioButton
              v-model="sync.providerConfig.value.active"
              inputId="provider-supabase"
              value="supabase"
              @change="sync.saveProviderConfig()"
            />
            <label for="provider-supabase">Supabase</label>
          </div>
          <div class="flex items-center gap-2">
            <RadioButton
              v-model="sync.providerConfig.value.active"
              inputId="provider-s3"
              value="s3"
              @change="sync.saveProviderConfig()"
            />
            <label for="provider-s3">S3-compatible</label>
          </div>
          <div class="flex items-center gap-2">
            <RadioButton
              v-model="sync.providerConfig.value.active"
              inputId="provider-github"
              value="github"
              @change="sync.saveProviderConfig()"
            />
            <label for="provider-github">GitHub</label>
          </div>
        </div>

        <!-- Supabase block -->
        <div class="flex flex-col gap-2">
          <div class="font-medium">Supabase</div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="sb-url">URL</label>
            <InputText
              id="sb-url"
              v-model="sync.providerConfig.value.supabase.url"
              class="sm:w-80"
              placeholder="https://xxx.supabase.co"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="sb-key">Anon key</label>
            <Password
              inputId="sb-key"
              v-model="sync.providerConfig.value.supabase.anonKey"
              :feedback="false"
              toggleMask
              inputClass="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="sb-bucket">Storage bucket</label>
            <InputText
              id="sb-bucket"
              v-model="sync.providerConfig.value.supabase.bucket"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
        </div>

        <!-- S3-compatible block -->
        <div class="flex flex-col gap-2">
          <div class="font-medium">S3-compatible (Backblaze B2 / Cloudflare R2)</div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-endpoint">Endpoint</label>
            <InputText
              id="s3-endpoint"
              v-model="sync.providerConfig.value.s3.endpoint"
              class="sm:w-80"
              placeholder="https://…"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-region">Region</label>
            <InputText
              id="s3-region"
              v-model="sync.providerConfig.value.s3.region"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-akid">Access key ID</label>
            <InputText
              id="s3-akid"
              v-model="sync.providerConfig.value.s3.accessKeyId"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-sk">Secret key</label>
            <Password
              inputId="s3-sk"
              v-model="sync.providerConfig.value.s3.secretKey"
              :feedback="false"
              toggleMask
              inputClass="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-bucket">Bucket</label>
            <InputText
              id="s3-bucket"
              v-model="sync.providerConfig.value.s3.bucket"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-key">Object key</label>
            <InputText
              id="s3-key"
              v-model="sync.providerConfig.value.s3.objectKey"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
        </div>

        <!-- GitHub block -->
        <div class="flex flex-col gap-2">
          <div class="font-medium">GitHub</div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="gh-repo">Repository</label>
            <InputText
              id="gh-repo"
              v-model="sync.providerConfig.value.github.repo"
              class="sm:w-80"
              placeholder="owner/repo"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="gh-branch">Branch</label>
            <InputText
              id="gh-branch"
              v-model="sync.providerConfig.value.github.branch"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="gh-path">Path</label>
            <InputText
              id="gh-path"
              v-model="sync.providerConfig.value.github.path"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="gh-token">Token (PAT)</label>
            <Password
              inputId="gh-token"
              v-model="sync.providerConfig.value.github.token"
              :feedback="false"
              toggleMask
              inputClass="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
        </div>
      </div>
    </template>
  </Card>
</template>
```

- [ ] **Step 2: Type-check and run the whole suite**

Run: `npm run type-check && npx vitest run`
Expected: type-check clean, all tests PASS.

- [ ] **Step 3: Lint the new code**

Run: `npm run lint`
Expected: clean. If ESLint flags `sync.providerConfig.value.foo = bar` mutation patterns inside the template, fix by either binding via the existing `@blur` handler or by reorganising into a per-field setter — the template-mutate approach is intentional here because each save handler reads from the same reactive object after blur.

- [ ] **Step 4: Visual verification (manual)**

Run: `npm run dev` and open the Settings page in a browser. Confirm:
- The four existing Visual controls still render and still work.
- A "This device" section appears with an editable Device name field. Editing it and clicking elsewhere persists across a hard reload.
- "Sync status" shows "Never synced from this device.", "Not available — sync codec not yet registered.", and "No remote connection." — all expected on a fresh device with no real provider wired in.
- "Sync provider" shows the four radios with "None" selected, and three credential blocks always visible. Filling fields and reloading should preserve them.

If anything renders broken, fix the template before committing.

- [ ] **Step 5: Commit**

```bash
git add src/views/SettingsView.vue
git commit -m "feat: surface sync identity, status, and provider credentials in Settings"
```

---

### Task 10: Update TASKS.md and final verification

**Files:**
- Modify: `TASKS.md`

- [ ] **Step 1: Move the sync-settings bullet from To Do into Done**

Edit `TASKS.md`:

Find the To Do block titled "Sync settings — device name, status surface, provider credentials" (added in commit `2c0a2fd`, nested under "External sync — provider, UI, and adapters") and delete it.

Then, in the **Done** section, add a new entry immediately after the existing **Database sync — merge engine & orchestration core** entry (so the sync work stays grouped):

```markdown
### Database sync — settings UI, identity, and provider credentials

The localStorage scaffolding, Settings UI, and `deviceName` identity
described in the design doc. The real `SyncProvider` and the app-launch
remote fetch are still ahead (see "External sync" below).

- `src/sync/localState/` directory — `storage.ts` (jsonStore / nullableJsonStore /
  stringStore with `moneytracker.sync.` key prefix and shallow default-merge
  for forward compatibility), `deviceName.ts` (UA-derived default + 8-char
  random hex suffix from `crypto.getRandomValues`), `remoteSnapshots.ts`
  (lastKnownRemoteState + lastFetchedRemoteSnapshot), `providerConfig.ts`
  (Supabase / S3-compatible / GitHub types + `EMPTY_PROVIDER_CONFIG`), plus
  a barrel `index.ts` preserving the existing import path
- `SyncMetadata.device` / `RemoteState.device` / `SyncDeps.deviceName` —
  renamed from the old UUIDv7 `deviceId`; merge logic unchanged because the
  field is opaque
- `getDatabaseCodec()` / `setDatabaseCodec()` singleton slot in `src/db/init.ts`
  — returns null today, populated by the External-sync plan
- `useSyncSettings` composable + three new Divider sections in
  `SettingsView.vue` (This device, Sync status, Sync provider). Settings never
  triggers a network call — the remote row reads only from
  `lastFetchedRemoteSnapshot`
- 31 new Vitest tests covering each storage helper, the UA parser, the
  default-name suffix, snapshot round-trips, provider-config forward
  compatibility, and the composable's reactive behaviour
- Design: [2026-05-27-sync-settings-design](docs/plans/2026-05-27-sync-settings-design.md)
- Plan: [2026-05-28-sync-settings-plan](docs/plans/2026-05-28-sync-settings-plan.md)
```

- [ ] **Step 2: Final whole-suite verification**

Run: `npm run type-check && npm run lint && npx vitest run`
Expected: clean type-check, clean lint, all tests PASS. Capture the test count from vitest's summary — should equal `(previous total) + 31`.

- [ ] **Step 3: Commit**

```bash
git add TASKS.md
git commit -m "docs: move sync-settings bullet to Done in TASKS.md"
```

---

## Self-review notes

Checked against `docs/plans/2026-05-27-sync-settings-design.md`:

- **Replace `deviceId` with `deviceName`; name is the identity** → Tasks 2 (mint default) + 6 (orchestrator rename). The default-name format `<browser> on <os> · <8 hex>` and the rationale (renaming = one harmless re-merge; suffix prevents un-renamed collisions) are tested in Task 2.
- **Cache the remote snapshot; never fetch from Settings** → Task 3 provides the slot; Task 8 reads only from it; Task 9 renders "No remote connection." when the slot is null. No `SyncProvider` import in Task 8 or 9.
- **Three credential blocks visible at once, one active via radio** → Task 9 renders all three blocks unconditionally with the radio above; Task 4 persists them in parallel regardless of `active`.
- **Secrets stored plaintext in localStorage** → Task 4 module comment captures the threat-model reasoning; Task 9 uses PrimeVue `Password` for visual masking only.
- **All sync state in one module, UI in a separate composable** → Tasks 1–5 keep `src/sync/localState/` plain TypeScript; Task 8 puts the Vue-aware code in `useSyncSettings.ts`. No Vue import inside `src/sync/`.
- **`storage.ts` shared helper** → Task 1 implements all three primitives (jsonStore, nullableJsonStore, stringStore) with `moneytracker.sync.` prefix and default-merge.
- **`defaultDeviceName()` UA + 8-char hex suffix via `crypto.getRandomValues`** → Task 2 step 3 implementation; tested in Task 2 step 1.
- **`useSyncSettings` reads codec/db via explicit deps** → Task 8 interface `SyncSettingsDeps`; codec absence handled by `recomputeLocalHash` falling back to null, which the UI renders as "not available" (Task 9).
- **`DatabaseCodec` singleton slot via `init.ts`** → Task 7 adds `getDatabaseCodec()` / `setDatabaseCodec()` matching the existing module pattern; Task 9 reads it; the External-sync plan will write to it.
- **No new e2e tests** → only Vitest specs added.
- **Files touched list in the design** → matches the per-task File lists above.

Placeholder scan: every step shows the actual content (no "TBD", "add error handling", or "similar to Task N"). Type names (`SyncSettingsDeps`, `SyncSettings`, `ProviderConfig`, `SyncProviderKind`, `EMPTY_PROVIDER_CONFIG`, `RemoteState`, `SyncMetadata`) are introduced in their owning task and consumed consistently in later tasks. The new `getDatabaseCodec` / `setDatabaseCodec` accessor names appear identically in Tasks 7 and 9.
