import { describe, it, expect } from 'vitest'
import { CENTRAL_BANKS, createCentralBank, RATES_REPO_FIRST_DATE } from '../providers/centralBanks'

const TODAY = '2026-10-26'

/** A fetch stub answering each URL in turn from `answers`, recording what was asked. */
function stubFetch(...answers: (Response | Error)[]) {
  const urls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input))
    inits.push(init)
    const answer = answers.shift()
    if (!answer) throw new Error(`unexpected request ${String(input)}`)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { urls, inits, fetchFn: fetchFn as typeof fetch }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const status = (code: number) => new Response('', { status: code })

describe('central bank providers', () => {
  it('cover the five banks of the rates repo, each in its home currency, on one level', () => {
    expect(CENTRAL_BANKS.map((b) => [b.id, b.home])).toEqual([
      ['ecb', 'EUR'],
      ['nbg', 'GEL'],
      ['nbk', 'KZT'],
      ['cba', 'AMD'],
      ['cbr', 'RUB'],
    ])
    expect(new Set(CENTRAL_BANKS.map((b) => createCentralBank(b).priority))).toEqual(new Set([10]))
  })

  it('read a dated day file and keep the publication date it names', async () => {
    const { urls, fetchFn } = stubFetch(
      json({ date: '2026-10-23', eur: { usd: 1.1193, czk: 24.327 } }),
    )
    const rows = await createCentralBank({ id: 'ecb', home: 'EUR' }, fetchFn).fetchDay(
      '2026-10-25',
      TODAY,
    )
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/xobotun/exchange-rates/main/v1/ecb/2026-10-25/currencies/eur.json',
    ])
    expect(rows).toEqual([
      {
        date: '2026-10-23',
        base_currency: 'EUR',
        provider: 'ecb',
        rates: { USD: 1.1193, CZK: 24.327 },
      },
    ])
  })

  it('ask for latest only for today, bypassing the browser cache', async () => {
    const today = stubFetch(json({ date: '2026-10-26', kzt: { eur: 0.002 } }))
    await createCentralBank({ id: 'nbk', home: 'KZT' }, today.fetchFn).fetchDay(TODAY, TODAY)
    expect(today.urls[0]).toContain('/v1/nbk/latest/currencies/kzt.json')
    expect(today.inits[0]?.cache).toBe('no-store')

    // The repo's latest is already today's, so yesterday needs its own file.
    const yesterday = stubFetch(json({ date: '2026-10-25', kzt: { eur: 0.002 } }))
    await createCentralBank({ id: 'nbk', home: 'KZT' }, yesterday.fetchFn).fetchDay(
      '2026-10-25',
      TODAY,
    )
    expect(yesterday.urls[0]).toContain('/v1/nbk/2026-10-25/currencies/kzt.json')
  })

  it('give up on a stalled connection', async () => {
    const { inits, fetchFn } = stubFetch(json({ date: '2026-10-23', amd: { kzt: 1.256 } }))
    await createCentralBank({ id: 'cba', home: 'AMD' }, fetchFn).fetchDay('2026-10-23', TODAY)
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it(`have nothing before ${RATES_REPO_FIRST_DATE}, without asking`, async () => {
    const { urls, fetchFn } = stubFetch()
    expect(
      await createCentralBank({ id: 'cbr', home: 'RUB' }, fetchFn).fetchDay('2019-12-23', TODAY),
    ).toEqual([])
    expect(urls).toEqual([])
  })

  it('have nothing for a day the repo does not hold yet (404)', async () => {
    const { fetchFn } = stubFetch(status(404))
    expect(
      await createCentralBank({ id: 'nbg', home: 'GEL' }, fetchFn).fetchDay('2021-06-01', TODAY),
    ).toEqual([])
  })

  it('reject when the repo cannot be reached', async () => {
    const { fetchFn } = stubFetch(new TypeError('Failed to fetch'))
    await expect(
      createCentralBank({ id: 'nbg', home: 'GEL' }, fetchFn).fetchDay('2026-10-20', TODAY),
    ).rejects.toThrow()
  })

  it('reject a file for another home currency', async () => {
    const { fetchFn } = stubFetch(json({ date: '2026-10-23', eur: { usd: 1.1 } }))
    await expect(
      createCentralBank({ id: 'nbk', home: 'KZT' }, fetchFn).fetchDay('2026-10-23', TODAY),
    ).rejects.toThrow()
  })
})
