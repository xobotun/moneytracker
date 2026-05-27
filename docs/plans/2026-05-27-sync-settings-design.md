# Sync Settings — Device Name, Status Surface, and Provider Credentials Design

> **Status:** design for an implementation plan. Brainstormed against the existing sync core (commit `8687e17`, plan [2026-05-22-database-sync-plan](2026-05-22-database-sync-plan.md)). The follow-up [writing-plans](https://github.com/anthropics/superpowers) pass turns this into the executable task list.

## Goal

Two related additions, packaged as one feature:

1. **Make sync identity legible.** Today `src/sync/localState.ts` stores a UUIDv7 `deviceId` that nothing displays. Replace it with a user-readable **device name** and surface the existing hash / timestamp / uploader fields in Settings as read-only data so the user can answer "did this device sync?" and "who last touched the remote?".
2. **Stage sync-provider configuration ahead of the real `SyncProvider`.** The External-sync plan still needs to pick between Supabase / S3-compatible (Backblaze B2 / Cloudflare R2) / GitHub. Persist credentials for all three now so the data is already in place when one is wired in.

## Out of scope (handled by the External-sync plan)

- The actual app-launch remote metadata fetch that populates the displayed "Last seen remote" cache. Settings reads the cache only; if no fetch has ever run, that row shows **"no remote connection"**.
- Instantiating a real `SyncProvider` from the stored credentials.
- A "Sync now" button.
- Validating credentials against the live service (no "test connection" button yet).

## Decisions and their why

### Replace `deviceId` with `deviceName`; name is the identity

The existing `SyncMetadata.device` and `RemoteState.device` fields are opaque strings to the sync algorithm — it only ever compares them with `===`. We can swap the UUIDv7 minted by `newId()` for a user-readable string without touching merge logic.

Trade-offs accepted on purpose:

- **Renaming a device causes one useless merge.** After rename, the local "device name" no longer equals the `device` recorded in the last upload's metadata, so `decideSync` returns `'merge'` instead of `'upload-local'`. The merge is a no-op against the device's own data, costs one extra round-trip, and self-corrects on the next sync.
- **Two un-renamed devices can collide.** Mitigated by appending an 8-char random hex suffix to the default name (`"Chrome on Windows · a3f4b7e1"`). Eight hex chars = 32 bits of entropy, ~1 in 4 billion collision per pair — fine for a household with 3–5 devices.
- **Two user-renamed devices can collide.** That's the user's call; the algorithm will treat them as one device and skip merges between them. Documented in the device-name help text in Settings.

The existing sync core (committed in `8687e17`) compiled and tested against `deviceId: string`. The change is purely a rename plus a different value source — no algorithmic change, no test logic change beyond updating identifier literals.

### Cache the remote snapshot; never fetch from Settings

Settings must never fire a network request when opened. The user explicitly asked for cache-only reads. The cache key (`lastFetchedRemoteSnapshot`) is populated by whatever subsystem fetches remote metadata — for now, only the future app-launch fetch. Until that lands, the row reads "no remote connection". This keeps the Settings UI a pure read of localStorage, with no awareness of `SyncProvider`.

### Three credential blocks visible at once, one active via radio

Visible-at-once + radio-selected-active was the user's preferred shape (see `AskUserQuestion` answers in the brainstorm). All three credential blocks are persisted regardless of which one is active, so switching providers and back doesn't lose data. The active selector drives only which `SyncProvider` the External-sync plan instantiates; today it has no runtime effect.

### Secrets stored plaintext in localStorage

A PWA's realistic threat is XSS, and any XSS that reaches localStorage already exfiltrates the SQLite database — encrypting tokens at rest with a passphrase doesn't raise the bar against that threat. Encryption only helps against attackers with disk read but no JS execution, which is a narrow scenario for a browser-hosted PWA. Documented in a `providerConfig`-section header comment in `localState.ts`.

### All sync state in one module, split into a directory of concerns

Sync localStorage state grows to four distinct concerns: device name, last-known-remote-state, last-fetched-remote-snapshot, provider config. Folding all four into a single `localState.ts` worked when there were only two; at four it stops reading well. Split into a directory (`src/sync/localState/`) matching the existing project convention (`src/db/migrations/`, `src/db/repositories/`), with a barrel `index.ts` that preserves the current import path.

A shared `storage.ts` helper factors out the boilerplate every store would otherwise repeat: key-prefixing with `moneytracker.sync.`, JSON parse with `try/catch`, default-merge for forward-compatibility (so adding a new field to `ProviderConfig` next year doesn't break the read of a value persisted today). Each domain file is then ~15–30 lines and reads like a schema declaration.

The whole module stays plain TypeScript with no Vue imports. The UI composable (`src/views/useSyncSettings.ts`) imports from `src/sync/localState/`. That's the decoupling seam: the storage module knows nothing about Vue, PrimeVue, or the DOM.

## Module shape

### `src/sync/localState/` (rewritten as a directory)

Files:

```
src/sync/localState/
  index.ts              # barrel re-exports — preserves `from './localState'` import path
  storage.ts            # typed localStorage helpers with "moneytracker.sync." prefix
  deviceName.ts         # device-name identity
  remoteSnapshots.ts    # last-known-remote-state + last-fetched-remote-snapshot
  providerConfig.ts     # provider types, defaults, load/save
```

Keys (all prefixed `moneytracker.sync.` by `storage.ts`):

| Key | Value | File | Status |
|---|---|---|---|
| `deviceName` | string — user-editable | `deviceName.ts` | **New (replaces `deviceId`)** |
| `lastKnownRemoteState` | JSON `{device, uploadedAtUtc, hash}` | `remoteSnapshots.ts` | Moved from existing |
| `lastFetchedRemoteSnapshot` | JSON `SyncMetadata` \| null | `remoteSnapshots.ts` | **New** |
| `providerConfig` | JSON `ProviderConfig` | `providerConfig.ts` | **New** |

#### `storage.ts` — shared helper

Factors out key-prefixing, JSON parse with try/catch, and default-merge for forward-compatibility:

```typescript
const PREFIX = 'moneytracker.sync.'

/** Typed JSON-backed slot in localStorage. `defaultValue` is also used as the
 *  template for default-merge on read: stored objects are spread over it so
 *  that adding new fields to a type does not break reads of older stored values. */
export function jsonStore<T extends object>(key: string, defaultValue: T) {
  const fullKey = PREFIX + key
  return {
    load(): T {
      const raw = localStorage.getItem(fullKey)
      if (!raw) return { ...defaultValue }
      try {
        return { ...defaultValue, ...(JSON.parse(raw) as Partial<T>) }
      } catch {
        return { ...defaultValue }
      }
    },
    save(value: T): void {
      localStorage.setItem(fullKey, JSON.stringify(value))
    },
  }
}

/** Nullable variant: returns null when nothing is stored. No default-merge —
 *  callers that need defaults wrap with jsonStore instead. */
export function nullableJsonStore<T>(key: string) { /* … */ }

/** Plain-string slot — no JSON envelope, for short identifiers. */
export function stringStore(key: string) { /* … */ }
```

#### Per-concern modules

```typescript
// src/sync/localState/deviceName.ts
const slot = stringStore('deviceName')
export function getDeviceName(): string                       // mints + persists default on first call
export function setDeviceName(name: string): void
export function defaultDeviceName(): string                   // exported for tests; UA + 8-char hex suffix

// src/sync/localState/remoteSnapshots.ts
const lastKnown = nullableJsonStore<RemoteState>('lastKnownRemoteState')
const lastFetched = nullableJsonStore<SyncMetadata>('lastFetchedRemoteSnapshot')
export function loadLastKnownRemoteState(): RemoteState | null
export function saveLastKnownRemoteState(state: RemoteState): void
export function loadLastFetchedRemoteSnapshot(): SyncMetadata | null
export function saveLastFetchedRemoteSnapshot(snapshot: SyncMetadata | null): void

// src/sync/localState/providerConfig.ts
export type SyncProviderKind = 'none' | 'supabase' | 's3' | 'github'
export interface SupabaseConfig { url: string; anonKey: string; bucket: string }
export interface S3Config { endpoint: string; region: string; accessKeyId: string; secretKey: string; bucket: string; objectKey: string }
export interface GitHubConfig { repo: string; branch: string; path: string; token: string }
export interface ProviderConfig { active: SyncProviderKind; supabase: SupabaseConfig; s3: S3Config; github: GitHubConfig }
export const EMPTY_PROVIDER_CONFIG: ProviderConfig            // sensible defaults (bucket = 'moneytracker', branch = 'main', etc.)
const slot = jsonStore<ProviderConfig>('providerConfig', EMPTY_PROVIDER_CONFIG)
export function loadProviderConfig(): ProviderConfig
export function saveProviderConfig(config: ProviderConfig): void

// src/sync/localState/index.ts — barrel
export * from './deviceName'
export * from './remoteSnapshots'
export * from './providerConfig'
```

`defaultDeviceName()` builds a string from `navigator.userAgentData` when available (Chromium browsers), falling back to a coarse parse of `navigator.userAgent`. Output examples: `"Chrome on Windows · a3f4b7e1"`, `"Firefox on Linux · 5e72a01b"`. The suffix uses `crypto.getRandomValues(new Uint8Array(4))` rendered as 8 lowercase hex chars.

`getDeviceName()` returns the stored value if present; otherwise calls `defaultDeviceName()`, persists it, and returns it. This means the value is **stable** across sessions — the random suffix is minted once and stays.

### Sync core knock-on changes

The merge/orchestrator code in `src/sync/` already treats `device` as opaque, so the changes are mechanical:

- `src/sync/types.ts` — no change (the `device: string` field comment may be updated to say "device name" instead of "device id").
- `src/sync/syncOrchestrator.ts` — `SyncDeps.deviceId` → `SyncDeps.deviceName`. Internal variable rename, no algorithm change.
- `src/sync/__tests__/syncOrchestrator.spec.ts` and `localState.spec.ts` — replace `getDeviceId` references and `deviceId: 'dev-A'` literals with the new names. Test behavior unchanged.

These are part of the same change to keep the codebase coherent.

### Settings UI — new sections in `src/views/SettingsView.vue`

Three `Divider`-separated blocks appended to the existing `Card`, in the same style as the current Visual section:

```
─ Visual ─
  (existing controls)

─ This device ─
  Device name:    [ My laptop                    ]   ← InputText, editable, persisted on blur
  ↳ help: "Used to identify this device when syncing.
           Renaming triggers one harmless re-merge on next sync."

─ Sync status ─
  Last sync (this device):
    When:         2026-05-22 14:30 UTC (3 hours ago)
    Uploaded by:  My laptop · a3f4b7e1 (this device)
    Hash:         a7f3c9…                          ← truncated, full value in title tooltip
  Current local database:
    Hash:         a7f3c9… (matches last sync)      ← computed on demand
    Computed at:  just now                          [ Recompute ]
  Last seen remote:
    No remote connection                           ← when cache is empty
    -- or --
    When:         2026-05-22 16:10 UTC
    Uploaded by:  Office iMac · 7b22ee01
    Hash:         d12af4…

─ Sync provider ─
  Active:  ( ) None  ( ) Supabase  (●) S3-compatible  ( ) GitHub

  Supabase
    URL:           [ https://xxx.supabase.co     ]
    Anon key:      [ ********                    ]   ← PrimeVue Password, :feedback="false"
    Storage bucket:[ moneytracker                ]

  S3-compatible (Backblaze B2 / Cloudflare R2)
    Endpoint:      [ https://…                   ]
    Region:        [ auto                        ]
    Access key ID: [ …                           ]
    Secret key:    [ ********                    ]
    Bucket:        [ moneytracker                ]
    Object key:    [ moneytracker.sqlite         ]

  GitHub
    Repository:    [ owner/repo                  ]
    Branch:        [ main                        ]
    Path:          [ moneytracker.sqlite         ]
    Token (PAT):   [ ********                    ]
```

PrimeVue components used: `InputText`, `Password` (with `:feedback="false"`), `RadioButton`, `Divider`. Tailwind classes match the existing Settings layout (`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1`).

All edits write through immediately on `@blur` (text fields) or `@change` (radio). No save button — matches the existing Settings pattern.

### `src/views/useSyncSettings.ts` (new composable)

Mirrors `useSettingsOptions.ts`'s shape. Responsibilities:

- Reactive refs backed by `localState` (device name, provider config, the three snapshots).
- `recomputeLocalHash()` — calls `codec.export(db)` then `codec.hash(blob)`. Lazy: runs once on mount, then only when the user clicks **Recompute**. The export is not free and the user shouldn't pay for it on every keystroke in another field.
- Pulls `Database` and `DatabaseCodec` from Vue's `inject()`. App bootstrap (`src/main.ts`) provides them. Until the External-sync plan registers a real codec, the injection token returns `null` and the "Current local database" rows render as **"not available"**.

### Files touched

```
src/sync/localState.ts                            (delete — superseded by the directory below)
src/sync/localState/index.ts                      (new — barrel)
src/sync/localState/storage.ts                    (new — jsonStore / nullableJsonStore / stringStore)
src/sync/localState/deviceName.ts                 (new — replaces deviceId)
src/sync/localState/remoteSnapshots.ts            (new — both snapshot slots)
src/sync/localState/providerConfig.ts             (new — provider types + load/save)
src/sync/types.ts                                 (touch — comment update on `device` field)
src/sync/syncOrchestrator.ts                      (rename — deviceId → deviceName in SyncDeps; import path unchanged thanks to barrel)
src/sync/__tests__/localState.spec.ts             (delete — replaced by per-module tests below)
src/sync/__tests__/localState/storage.spec.ts    (new)
src/sync/__tests__/localState/deviceName.spec.ts (new)
src/sync/__tests__/localState/remoteSnapshots.spec.ts (new)
src/sync/__tests__/localState/providerConfig.spec.ts (new)
src/sync/__tests__/syncOrchestrator.spec.ts      (update — rename literals)
src/views/SettingsView.vue                        (add — three new Divider sections)
src/views/useSyncSettings.ts                      (new)
src/views/__tests__/useSyncSettings.spec.ts      (new)
src/main.ts                                       (touch — provide Database + DatabaseCodec injection tokens)
TASKS.md                                          (touch — move new bullet under Done when landed)
```

## Testing

- **`localState/storage.spec.ts`** — assert key-prefixing, default-merge on read (stored partial spreads over default), graceful fallback on malformed JSON.
- **`localState/deviceName.spec.ts`** — round-trip set/get, default-name format matches `/^.+ · [0-9a-f]{8}$/`, two calls to `defaultDeviceName()` produce different suffixes, `getDeviceName()` mints once and is stable across reads.
- **`localState/remoteSnapshots.spec.ts`** — null when never written, round-trip each slot.
- **`localState/providerConfig.spec.ts`** — `EMPTY_PROVIDER_CONFIG` round-trips, partial stored value merges over the empty default (forward-compatibility for added fields), active-provider radio change persists.
- **`useSyncSettings.spec.ts`** — mount the composable with fakes injected, assert it renders each state correctly (no remote / cached remote / current-local available / current-local unavailable), assert text-field blur writes through to localStorage, assert provider radio change writes through.
- **Existing sync-core tests** — no behavior change; only identifier renames.
- **No new e2e** — keep Playwright untouched until External-sync adds real flows.

## Self-review

- **Placeholder scan:** no TBDs or vague requirements. "Implementation lands in External-sync plan" is concrete (specific seams: app-launch fetch, codec injection, provider instantiation).
- **Internal consistency:** "Replace `deviceId`" stated once in Decisions and again in Module shape; matches the file list (rewriting `localState.ts` + renaming in orchestrator + tests). The "Last seen remote" cache-only contract is the same in Decisions, UI mockup, and composable description.
- **Scope check:** focused — one settings page block, one localStorage module, no algorithm changes. Sized for a single implementation plan.
- **Ambiguity check:** the cache-only contract is explicit ("Settings reads the cache only"). The "useless merge after rename" caveat is documented and surfaced in the device-name help text. The 8-char suffix uses `crypto.getRandomValues(new Uint8Array(4))` rendered as lowercase hex — fully specified.
