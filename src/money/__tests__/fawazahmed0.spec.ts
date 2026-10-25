import { describe, it, expect } from 'vitest'
import { createFawazahmed0, FAWAZAHMED0_FIRST_DATE } from '../providers/fawazahmed0'

const TODAY = '2026-10-25'

/** A fetch stub answering each URL in turn from `answers`, recording the URLs. */
function stubFetch(...answers: (Response | Error)[]) {
  const urls: string[] = []
  const fetchFn = async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const answer = answers.shift()
    if (!answer) throw new Error(`unexpected request ${String(input)}`)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { urls, fetchFn: fetchFn as typeof fetch }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const status = (code: number) => new Response('', { status: code })

describe('fawazahmed0 provider', () => {
  it('is on the aggregator level', () => {
    const p = createFawazahmed0()
    expect(p.id).toBe('fawazahmed0')
    expect(p.priority).toBe(20)
  })

  it('fetches the dated EUR file and upper-cases the codes', async () => {
    const { urls, fetchFn } = stubFetch(
      json({ date: '2025-06-10', eur: { usd: 1.14, kzt: 590.1 } }),
    )
    const rows = await createFawazahmed0(fetchFn).fetchDay('2025-06-10', TODAY)
    expect(urls).toEqual([
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2025-06-10/v1/currencies/eur.min.json',
    ])
    expect(rows).toEqual([
      {
        date: '2025-06-10',
        base_currency: 'EUR',
        provider: 'fawazahmed0',
        rates: { USD: 1.14, KZT: 590.1 },
      },
    ])
  })

  it('asks for the latest file for today and yesterday, dated as published', async () => {
    const { urls, fetchFn } = stubFetch(json({ date: '2026-10-24', eur: { usd: 1.12 } }))
    const rows = await createFawazahmed0(fetchFn).fetchDay('2026-10-25', TODAY)
    expect(urls[0]).toContain('@latest/')
    expect(rows[0]!.date).toBe('2026-10-24')

    const second = stubFetch(json({ date: '2026-10-24', eur: { usd: 1.12 } }))
    await createFawazahmed0(second.fetchFn).fetchDay('2026-10-24', TODAY)
    expect(second.urls[0]).toContain('@latest/')
  })

  it('falls back to the mirror when the CDN fails', async () => {
    const { urls, fetchFn } = stubFetch(
      status(503),
      json({ date: '2025-06-10', eur: { usd: 1.14 } }),
    )
    const rows = await createFawazahmed0(fetchFn).fetchDay('2025-06-10', TODAY)
    expect(urls[1]).toBe('https://2025-06-10.currency-api.pages.dev/v1/currencies/eur.min.json')
    expect(rows).toHaveLength(1)

    const offline = stubFetch(
      new TypeError('Failed to fetch'),
      json({ date: '2025-06-10', eur: {} }),
    )
    await createFawazahmed0(offline.fetchFn).fetchDay('2025-06-10', TODAY)
    expect(offline.urls).toHaveLength(2)
  })

  it(`has nothing before ${FAWAZAHMED0_FIRST_DATE}`, async () => {
    const { urls, fetchFn } = stubFetch()
    expect(await createFawazahmed0(fetchFn).fetchDay('2024-03-01', TODAY)).toEqual([])
    expect(urls).toEqual([])
  })

  it('has nothing when both sources say 404', async () => {
    const { fetchFn } = stubFetch(status(404), status(404))
    expect(await createFawazahmed0(fetchFn).fetchDay('2025-06-10', TODAY)).toEqual([])
  })

  it('rejects when both sources fail otherwise', async () => {
    const { fetchFn } = stubFetch(status(503), new TypeError('Failed to fetch'))
    await expect(createFawazahmed0(fetchFn).fetchDay('2025-06-10', TODAY)).rejects.toThrow()
  })

  it('rejects a body that is not a rate file', async () => {
    const { fetchFn } = stubFetch(json({ date: 'soon', eur: { usd: 1 } }))
    await expect(createFawazahmed0(fetchFn).fetchDay('2025-06-10', TODAY)).rejects.toThrow()
  })

  it('drops junk codes and values', async () => {
    const { fetchFn } = stubFetch(
      json({
        date: '2025-06-10',
        eur: { $myro: 7.7, '': 1, usd: 'x', gbp: 0, chf: -1, jpy: null, '1inch': 12.3, aed: 4.1 },
      }),
    )
    const [row] = await createFawazahmed0(fetchFn).fetchDay('2025-06-10', TODAY)
    expect(row!.rates).toEqual({ '1INCH': 12.3, AED: 4.1 })
  })
})
