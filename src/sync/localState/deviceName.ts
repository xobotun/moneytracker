import { stringStore } from './storage'

// The device name is the sync identity: it is what `SyncMetadata.device` and
// `RemoteState.device` carry to every other device. Two design choices to
// note for future readers:
//
//  1. We deliberately use a human-readable name instead of an opaque UUID so
//     Settings can display "Office iMac" instead of "019432bc-…". The trade-off
//     is documented in docs/plans/2026-05-27-sync-settings-design.md:
//     renaming triggers one harmless re-merge; un-renamed devices rely on the
//     8-char random suffix to stay distinguishable. Names must stay unique:
//     sync treats a remote upload under this device's name as its own, so a
//     duplicate name skips the merge (see TASKS.md, known sync defects).
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
