import { addDays } from '../dates'
import { PROVIDER_LEVELS } from '../levels'
import type { RateProvider } from '../providers'
import { downloadRateFile, parseRateFile } from './rateFile'

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
      const body = await downloadRateFile(fetchFn, urls(tag), tag === 'latest')
      return body === null ? [] : [parseRateFile(body, 'EUR', 'fawazahmed0')]
    },
  }
}
