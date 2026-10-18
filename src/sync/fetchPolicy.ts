/** Upper bound for one sync HTTP request; a stalled connection otherwise never settles. */
export const SYNC_FETCH_TIMEOUT_MS = 60_000

/**
 * Wraps a fetch so every sync request:
 *  - bypasses the browser HTTP cache (`cache: 'no-store'`). Providers may send
 *    cacheable GETs (GitHub's API answers with `max-age=60`); a cached, stale
 *    branch head or metadata file makes every compare-and-swap fail.
 *  - is aborted after `timeoutMs`, unless the caller passed its own signal.
 *    `fetch` has no default timeout, so a dead connection would leave a sync
 *    hanging until reload.
 */
export function withSyncFetchPolicy<Input>(
  fetchFn: (input: Input, init?: RequestInit) => Promise<Response>,
  timeoutMs: number = SYNC_FETCH_TIMEOUT_MS,
): (input: Input, init?: RequestInit) => Promise<Response> {
  return (input, init) =>
    fetchFn(input, {
      ...init,
      cache: 'no-store',
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    })
}
