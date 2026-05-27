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

### All sync state in one file, UI in a separate composable

`src/sync/localState.ts` keeps everything — device name, last-known-remote-state, last-fetched-remote-snapshot, provider config (types and storage). It stays plain TypeScript with no Vue imports.

The UI composable (`src/views/useSyncSettings.ts`) imports from `localState.ts`. That's the decoupling seam: the storage module knows nothing about Vue, PrimeVue, or the DOM. File-count splitting (a separate `providerConfig.ts`) would have been hygiene, not coupling, and the combined file stays ~110 lines.

## Module shape

### `src/sync/localState.ts` (rewritten)

Keys (all prefixed `moneytracker.sync.`):

| Key | Value | Status |
|---|---|---|
| `deviceName` | string — user-editable | **New (replaces `deviceId`)** |
| `lastKnownRemoteState` | JSON `{device, uploadedAtUtc, hash}` | Exists |
| `lastFetchedRemoteSnapshot` | JSON `SyncMetadata` \| null | **New** |
| `providerConfig` | JSON `ProviderConfig` | **New** |

Exports:

```typescript
// Device name — identity for sync, displayed in Settings.
export function getDeviceName(): string                       // mints + persists default on first call
export function setDeviceName(name: string): void
export function defaultDeviceName(): string                   // exported for tests; UA + 8-char hex suffix

// Already exists, unchanged in behavior:
export function loadLastKnownRemoteState(): RemoteState | null
export function saveLastKnownRemoteState(state: RemoteState): void

// New — cache of the most recent remote metadata fetched at app launch.
export function loadLastFetchedRemoteSnapshot(): SyncMetadata | null
export function saveLastFetchedRemoteSnapshot(snapshot: SyncMetadata | null): void

// New — provider configuration types and storage.
export type SyncProviderKind = 'none' | 'supabase' | 's3' | 'github'
export interface SupabaseConfig { url: string; anonKey: string; bucket: string }
export interface S3Config { endpoint: string; region: string; accessKeyId: string; secretKey: string; bucket: string; objectKey: string }
export interface GitHubConfig { repo: string; branch: string; path: string; token: string }
export interface ProviderConfig { active: SyncProviderKind; supabase: SupabaseConfig; s3: S3Config; github: GitHubConfig }
export const EMPTY_PROVIDER_CONFIG: ProviderConfig            // sensible defaults (bucket = 'moneytracker', branch = 'main', etc.)
export function loadProviderConfig(): ProviderConfig          // merges stored config over EMPTY_PROVIDER_CONFIG, so new fields don't break older stored values
export function saveProviderConfig(config: ProviderConfig): void
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
src/sync/localState.ts                            (rewrite — replace deviceId with deviceName, add snapshot + provider state)
src/sync/types.ts                                 (touch — comment update on `device` field)
src/sync/syncOrchestrator.ts                      (rename — deviceId → deviceName in SyncDeps)
src/sync/__tests__/localState.spec.ts             (rewrite — tests for new exports + default-name suffix)
src/sync/__tests__/syncOrchestrator.spec.ts      (update — rename literals)
src/views/SettingsView.vue                        (add — three new Divider sections)
src/views/useSyncSettings.ts                      (new)
src/views/__tests__/useSyncSettings.spec.ts      (new)
src/main.ts                                       (touch — provide Database + DatabaseCodec injection tokens)
TASKS.md                                          (touch — move new bullet under Done when landed)
```

## Testing

- **`localState.spec.ts`** — round-trip each new key, assert default-name format matches `/^.+ · [0-9a-f]{8}$/`, assert two calls to `defaultDeviceName()` produce different suffixes, assert `getDeviceName()` mints once and is stable across reads.
- **`useSyncSettings.spec.ts`** — mount the composable with fakes injected, assert it renders each state correctly (no remote / cached remote / current-local available / current-local unavailable), assert text-field blur writes through to localStorage, assert provider radio change writes through.
- **Existing sync-core tests** — no behavior change; only identifier renames.
- **No new e2e** — keep Playwright untouched until External-sync adds real flows.

## Self-review

- **Placeholder scan:** no TBDs or vague requirements. "Implementation lands in External-sync plan" is concrete (specific seams: app-launch fetch, codec injection, provider instantiation).
- **Internal consistency:** "Replace `deviceId`" stated once in Decisions and again in Module shape; matches the file list (rewriting `localState.ts` + renaming in orchestrator + tests). The "Last seen remote" cache-only contract is the same in Decisions, UI mockup, and composable description.
- **Scope check:** focused — one settings page block, one localStorage module, no algorithm changes. Sized for a single implementation plan.
- **Ambiguity check:** the cache-only contract is explicit ("Settings reads the cache only"). The "useless merge after rename" caveat is documented and surfaced in the device-name help text. The 8-char suffix uses `crypto.getRandomValues(new Uint8Array(4))` rendered as lowercase hex — fully specified.
