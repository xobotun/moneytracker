// Display helpers for currency codes. Codes are free-form (ISO 4217 or custom
// like BTC) and Intl knows only ISO ones, so both helpers return null for
// anything it cannot describe instead of throwing.

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
