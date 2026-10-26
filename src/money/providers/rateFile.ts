import type { ExchangeRateInput } from '../providers'

// The rate-file format fawazahmed0/exchange-api introduced and the rates repo
// (xobotun/exchange-rates) follows: `{"date": "YYYY-MM-DD", "<home>": {"<code>":
// <units of code per 1 home>, …}}`, lowercase codes.

/** Upper bound for one request; a stalled connection otherwise never settles. */
export const RATE_FETCH_TIMEOUT_MS = 30_000

const CODE = /^[a-z0-9]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The file from the first of `urls` that has it; null when every one says 404;
 * rejects when none answered and not all said 404.
 *
 * A dated file never changes, so the browser cache may serve it. A `latest`
 * one must bypass it: a cached copy (jsDelivr marks fawazahmed0's cacheable
 * for a week) would freeze the rates at the first day's.
 */
export async function downloadRateFile(
  fetchFn: typeof fetch,
  urls: readonly string[],
  latest: boolean,
): Promise<unknown> {
  let lastError: unknown = null
  let allMissing = true
  for (const url of urls) {
    try {
      const response = await fetchFn(url, {
        cache: latest ? 'no-store' : 'default',
        signal: AbortSignal.timeout(RATE_FETCH_TIMEOUT_MS),
      })
      if (response.ok) return await response.json()
      if (response.status !== 404) allMissing = false
      lastError = new Error(`${url} answered ${response.status}`)
    } catch (e) {
      allMissing = false
      lastError = e
    }
  }
  if (allMissing) return null
  throw lastError
}

/**
 * A rate file of `home` (upper-case) as a reference row of `provider`. Codes
 * are upper-cased; anything that is not a code with a positive finite rate
 * is dropped. Rejects a body that is not a rate file of that currency.
 */
export function parseRateFile(body: unknown, home: string, provider: string): ExchangeRateInput {
  const { date, [home.toLowerCase()]: quoted } = (body ?? {}) as Record<string, unknown>
  if (
    typeof date !== 'string' ||
    !DATE.test(date) ||
    typeof quoted !== 'object' ||
    quoted === null
  ) {
    throw new Error(`${provider}: the response is not a ${home} rate file`)
  }
  const rates: Record<string, number> = {}
  for (const [code, value] of Object.entries(quoted)) {
    if (CODE.test(code) && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      rates[code.toUpperCase()] = value
    }
  }
  return { date, base_currency: home, provider, rates }
}
