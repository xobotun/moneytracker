import { addDays } from '../dates'
import { PROVIDER_LEVELS } from '../levels'
import type { ExchangeRateInput, RateProvider } from '../providers'

// fawazahmed0/exchange-api: free, keyless daily rates for ~340 codes
// (fiat, metals, crypto), served from jsDelivr with a Cloudflare Pages mirror.
// Its sources are not public; every file is derived from one EUR-based set, so
// only the EUR file is fetched — the other bases would be crosses through EUR.

/** The first dated release; there is nothing earlier. */
export const FAWAZAHMED0_FIRST_DATE = '2024-03-02'

const urls = (tag: string) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/eur.min.json`,
  `https://${tag}.currency-api.pages.dev/v1/currencies/eur.min.json`,
]

const CODE = /^[a-z0-9]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Upper bound for one request; a stalled connection otherwise never settles. */
export const RATE_FETCH_TIMEOUT_MS = 30_000

/**
 * The file for `tag` from the first source that has it; null when every source
 * says 404; rejects when none answered and not all said 404.
 *
 * A dated file never changes, so the browser cache may serve it. `latest`
 * must bypass it: jsDelivr marks it cacheable for a week (`max-age=604800`),
 * and a cached copy would freeze the rates at the first day's.
 */
async function download(fetchFn: typeof fetch, tag: string): Promise<unknown> {
  let lastError: unknown = null
  let allMissing = true
  for (const url of urls(tag)) {
    try {
      const response = await fetchFn(url, {
        cache: tag === 'latest' ? 'no-store' : 'default',
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

function parse(body: unknown): ExchangeRateInput {
  const { date, eur } = (body ?? {}) as { date?: unknown; eur?: unknown }
  if (typeof date !== 'string' || !DATE.test(date) || typeof eur !== 'object' || eur === null) {
    throw new Error('fawazahmed0: the response is not a rate file')
  }
  const rates: Record<string, number> = {}
  for (const [code, value] of Object.entries(eur)) {
    if (CODE.test(code) && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      rates[code.toUpperCase()] = value
    }
  }
  return { date, base_currency: 'EUR', provider: 'fawazahmed0', rates }
}

export function createFawazahmed0(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): RateProvider {
  return {
    id: 'fawazahmed0',
    priority: PROVIDER_LEVELS.fawazahmed0!,
    async fetchDay(date, today) {
      if (date < FAWAZAHMED0_FIRST_DATE) return []
      // Today's file appears during the day and `latest` lags a day: ask for
      // the newest instead, and store it under the date it carries.
      const tag = date >= addDays(today, -1) ? 'latest' : date
      const body = await download(fetchFn, tag)
      return body === null ? [] : [parse(body)]
    },
  }
}
