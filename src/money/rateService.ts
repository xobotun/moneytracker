import type { AppliedRatesRepository } from '@/db/repositories/AppliedRatesRepository'
import type { ExchangeRatesRepository } from '@/db/repositories/ExchangeRatesRepository'
import { addDays } from './dates'
import type { RateProvider } from './providers'
import { isBetter, isFinal, LOOKBACK_DAYS, resolveAtLevel, type Resolution } from './resolveRate'

export interface RateServiceDeps {
  exchangeRates: ExchangeRatesRepository
  appliedRates: AppliedRatesRepository
  providers: readonly RateProvider[]
  /** The device's date, 'YYYY-MM-DD'. */
  today: () => string
}

/**
 * Keeps `applied_rates` filled: resolves a day's pairs from the local reference
 * library, fetching from the providers what it lacks, level by level (see
 * resolveRate.ts for the rules).
 *
 * Network work never runs inside a database transaction: each fetch completes
 * before its rows are saved, one statement at a time. Each provider day is
 * fetched at most once per session (until `refresh`); concurrent callers share
 * the request. A failed fetch is logged and counts as "nothing there".
 */
export class RateService {
  /** Provider days asked for this session: `provider|date` → whether it answered. */
  private fetches = new Map<string, { job: Promise<boolean>; done: boolean }>()
  /** Pairs being resolved: `date|a|b` → whether a row was written. */
  private ensuring = new Map<string, Promise<boolean>>()

  constructor(private readonly deps: RateServiceDeps) {}

  /**
   * Makes sure each pair (either order) has an applied rate on `date`: resolves
   * those with no row or one that may still improve. Returns how many rows
   * were written.
   */
  async ensure(date: string, pairs: readonly (readonly [string, string])[]): Promise<number> {
    const written = await Promise.all(pairs.map(([x, y]) => this.ensureOne(date, x, y)))
    return written.filter(Boolean).length
  }

  /**
   * Fetches every provider's newest rates, then resolves again the recent rows
   * that may improve. Rejects when no provider answered. Returns the newest
   * date the library now holds.
   */
  async refresh(): Promise<{ newest: string | null }> {
    const { providers, appliedRates, exchangeRates, today } = this.deps
    // Forget the finished fetches; one still running is as fresh as a new one.
    for (const [key, entry] of this.fetches) if (entry.done) this.fetches.delete(key)
    const answered = await Promise.all(providers.map((p) => this.fetchDay(p, today())))
    if (!answered.some(Boolean)) throw new Error('None of the rate sources answered.')
    const recent = await appliedRates.listAuto(addDays(today(), -(LOOKBACK_DAYS + 1)))
    await Promise.all(recent.map((r) => this.ensureOne(r.date, r.currency_a, r.currency_b)))
    return { newest: await exchangeRates.newestDate() }
  }

  /** Whether the library has nothing from yesterday or later. */
  async isStale(): Promise<boolean> {
    const newest = await this.deps.exchangeRates.newestDate()
    return newest === null || newest < addDays(this.deps.today(), -1)
  }

  private ensureOne(date: string, x: string, y: string): Promise<boolean> {
    if (x === y) return Promise.resolve(false)
    const [a, b] = x < y ? [x, y] : [y, x]
    const key = `${date}|${a}|${b}`
    let job = this.ensuring.get(key)
    if (!job) {
      job = this.resolveAndSave(date, a, b).finally(() => this.ensuring.delete(key))
      this.ensuring.set(key, job)
    }
    return job
  }

  private async resolveAndSave(date: string, a: string, b: string): Promise<boolean> {
    const { appliedRates, providers, today } = this.deps
    const current = await appliedRates.find(date, a, b)
    if (current && isFinal(current, today(), providers)) return false
    const found = await this.resolve(date, a, b)
    if (found === null) {
      // Nothing now: keep what is there; record the gap only when there is nothing.
      return current ? false : appliedRates.saveAuto({ date, x: a, y: b, resolution: null })
    }
    if (!isBetter(found, current, providers)) return false
    return appliedRates.saveAuto({ date, x: a, y: b, resolution: found })
  }

  /**
   * Level by level: the local library first; when it has nothing, only a
   * cross, or only an older day, fetch the level's providers for the date and
   * look again. The first level with an answer wins.
   */
  private async resolve(date: string, a: string, b: string): Promise<Resolution | null> {
    const { exchangeRates, providers } = this.deps
    const read = () => exchangeRates.listBetween(addDays(date, -LOOKBACK_DAYS), date)
    const levels = [...new Set(providers.map((p) => p.priority))].sort((x, y) => x - y)
    let rows = await read()
    for (const level of levels) {
      let found = resolveAtLevel(date, a, b, rows, providers, level)
      if (found === null || found.via !== null || found.referenceDate < date) {
        await Promise.all(
          providers.filter((p) => p.priority === level).map((p) => this.fetchDay(p, date)),
        )
        rows = await read()
        found = resolveAtLevel(date, a, b, rows, providers, level)
      }
      if (found) return found
    }
    return null
  }

  /** Fetches and stores one provider day, once per session; true when it answered. */
  private fetchDay(provider: RateProvider, date: string): Promise<boolean> {
    const key = `${provider.id}|${date}`
    const known = this.fetches.get(key)
    if (known) return known.job
    const entry = { job: Promise.resolve(false), done: false }
    entry.job = (async () => {
      try {
        const rows = await provider.fetchDay(date, this.deps.today())
        for (const row of rows) await this.deps.exchangeRates.save(row)
        return true
      } catch (e) {
        console.warn(`Could not fetch the ${provider.id} rates for ${date}.`, e)
        return false
      } finally {
        entry.done = true
      }
    })()
    this.fetches.set(key, entry)
    return entry.job
  }
}
