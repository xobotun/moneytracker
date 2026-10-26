import { PROVIDER_LEVELS } from '../levels'
import type { RateProvider } from '../providers'
import { downloadRateFile, parseRateFile } from './rateFile'

// Central banks' official rates, read from the rates repo
// (https://github.com/xobotun/exchange-rates — its README is the contract).
// It republishes each bank in its home currency, in fawazahmed0's file format,
// with a file for every calendar day: on a day the bank did not publish, the
// file repeats the newest earlier publication under that publication's date.
// raw.githubusercontent.com allows any origin, which the banks' own sites do
// not (NBK, CBA, CBR).

export const RATES_REPO_URL = 'https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1'

/** The repo's history starts here; a date it does not hold yet answers 404. */
export const RATES_REPO_FIRST_DATE = '2019-12-24'

export interface CentralBank {
  /** The repo's provider id. */
  id: string
  /** The bank's home currency, the base of its files. */
  home: string
}

export const CENTRAL_BANKS: readonly CentralBank[] = [
  { id: 'ecb', home: 'EUR' },
  { id: 'nbg', home: 'GEL' },
  { id: 'nbk', home: 'KZT' },
  { id: 'cba', home: 'AMD' },
  { id: 'cbr', home: 'RUB' },
]

export function createCentralBank(
  { id, home }: CentralBank,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): RateProvider {
  return {
    id,
    priority: PROVIDER_LEVELS[id]!,
    async fetchDay(date, today) {
      if (date < RATES_REPO_FIRST_DATE) return []
      // The repo's `latest` is the newest day file, already today's (unlike
      // fawazahmed0's, which lags a day). Today's own file may not exist yet,
      // so ask for `latest` then; every earlier day has its own file.
      const tag = date >= today ? 'latest' : date
      const url = `${RATES_REPO_URL}/${id}/${tag}/currencies/${home.toLowerCase()}.json`
      const body = await downloadRateFile(fetchFn, [url], tag === 'latest')
      return body === null ? [] : [parseRateFile(body, home, id)]
    },
  }
}
