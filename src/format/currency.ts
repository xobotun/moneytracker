import type { MoneyAmount } from '@/db/MoneyAmount'

// Display helpers for currencies and amounts. Codes are free-form (ISO 4217 or
// custom like USDT) and Intl knows only ISO ones, so nothing here throws on an
// unknown code: lookups return null, formatting falls back to number + code.

const symbols = new Map<string, string | null>()

/**
 * The currency's narrow symbol — '$', '€', '₽' — or null when it has none of
 * its own (Intl falls back to the code, e.g. CHF) or the code is not ISO 4217.
 */
export function currencySymbol(code: string): string | null {
  let symbol = symbols.get(code)
  if (symbol === undefined) {
    symbol = null
    try {
      const part = new Intl.NumberFormat('en', {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol',
      })
        .formatToParts(0)
        .find((p) => p.type === 'currency')
      if (part && part.value !== code) symbol = part.value
    } catch {
      // Not a well-formed currency code (USDT, ''): no symbol.
    }
    symbols.set(code, symbol)
  }
  return symbol
}

const names =
  typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'currency', fallback: 'none' })
    : null

/** The English name — 'Euro' — or null for a code Intl does not know. */
export function currencyName(code: string): string | null {
  try {
    return names?.of(code) ?? null
  } catch {
    return null // not a well-formed code
  }
}

/** How many decimals a currency usually shows (2; JPY 0); 2 for a code Intl does not know. */
function usualDecimals(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .minimumFractionDigits ?? 2
    )
  } catch {
    return 2
  }
}

function format(value: number, currency: string, decimals: [number, number], locale?: string) {
  const [minimumFractionDigits, maximumFractionDigits] = decimals
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: currencySymbol(currency) ? 'narrowSymbol' : 'code',
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(value)
  } catch {
    // Not a code Intl accepts (USDT): the plain number, then the code.
    const number = new Intl.NumberFormat(locale, {
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(value)
    return `${number} ${currency}`
  }
}

/**
 * An exact amount for display: the currency's symbol where it has one ($, €,
 * ₽), its code otherwise; its usual decimals, and more when the stored amount
 * has them (0.00000001 BTC), never fewer meaningful ones. `locale` defaults to
 * the browser's.
 */
export function formatMoney(amount: MoneyAmount, locale?: string): string {
  const usual = usualDecimals(amount.currency)
  const value = amount.value / 10 ** amount.scale
  return format(value, amount.currency, [usual, Math.max(usual, amount.scale)], locale)
}

/** A converted, approximate amount, rounded to its currency's usual decimals. */
export function formatApprox(amount: { value: number; currency: string }, locale?: string): string {
  const usual = usualDecimals(amount.currency)
  return format(amount.value, amount.currency, [usual, usual], locale)
}

/** A typed code as stored: trimmed and upper-cased ('  usd ' → 'USD'). */
export function normaliseCurrencyCode(code: string): string {
  return code.trim().toUpperCase()
}

/** Why `code` cannot be a currency code, or null when it can (before normalising). */
export function currencyCodeError(code: string): string | null {
  const trimmed = code.trim()
  if (trimmed === '') return 'Enter a currency code, e.g. EUR or BTC.'
  if (/\s/.test(trimmed)) return 'A currency code has no spaces.'
  return null
}

// Intl.supportedValuesOf is ES2022, above the ES2020 lib the app is checked
// against (Vite's build target), and missing in older browsers.
const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'currency') => string[] }
const ISO_CURRENCIES: readonly string[] = intl.supportedValuesOf?.('currency') ?? []

/**
 * Currency codes for `query`: codes starting with it (`preferred` ones first,
 * then ISO 4217), then codes whose name contains it ('ruble' → RUB).
 */
export function currencySuggestions(query: string, preferred: readonly string[] = []): string[] {
  const q = query.trim()
  const all = [...new Set([...preferred, ...ISO_CURRENCIES])]
  const byCode = all.filter((c) => c.startsWith(q.toUpperCase()))
  if (q === '') return byCode
  const byName = all.filter(
    (c) => !byCode.includes(c) && currencyName(c)?.toLowerCase().includes(q.toLowerCase()),
  )
  return [...byCode, ...byName]
}
