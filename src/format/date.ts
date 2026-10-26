/**
 * A calendar day ('YYYY-MM-DD') for display, e.g. "24 Oct 2026". Formatted in
 * UTC, where the string's midnight lies, so no time zone shifts it a day.
 */
export function formatDay(date: string, locale?: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
