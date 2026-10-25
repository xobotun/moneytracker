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
