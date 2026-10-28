/**
 * A distance for display: whole metres below a kilometre ("25 m"),
 * kilometres with at most one decimal from there ("1.3 km", "9 km"); a
 * no-break space keeps the number with its unit.
 */
export function formatMetres(metres: number, locale?: string): string {
  if (metres < 1000) return `${Math.round(metres)}\u00a0m`
  const km = (metres / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })
  return `${km}\u00a0km`
}
