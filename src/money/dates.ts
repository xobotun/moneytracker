// Calendar dates as 'YYYY-MM-DD' strings — the form exchange rates are keyed
// by. They name a day, not an instant, so arithmetic runs in UTC where every
// day has 24 hours.

const pad = (n: number) => String(n).padStart(2, '0')

/** The device's calendar date now (local time, not UTC). */
export function todayLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Whether `text` is a real calendar date written 'YYYY-MM-DD' (2026-02-30 is not). */
export function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const d = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text
}

/** `date` moved by `days` calendar days (negative = back). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
