import type { ShortId } from '@/db/shortId'
import type { TagDetailField, TagDetailValues } from '@/db/types'
import { positionError, radiusError } from './tagForm'

// The answers of the merge dialog, kept out of the component so they can be
// tested without mounting PrimeVue.

/** Keep the source's value, the target's, or another one the user types. */
export type Choice = 'source' | 'target' | 'other'

/** The user's answer for one differing detail; the other fields hold what was typed. */
export interface Answer {
  choice: Choice | null
  text: string
  latitude: number | null
  longitude: number | null
  radius: number | null
  link: ShortId | null
  date: Date | null
}

export function emptyAnswer(): Answer {
  return {
    choice: null,
    text: '',
    latitude: null,
    longitude: null,
    radius: null,
    link: null,
    date: null,
  }
}

function toIso(date: Date | null): string | null {
  if (!date) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The value typed for `field` ("another"); empty means none, which clears it. */
export function typedValue(field: TagDetailField, a: Answer): TagDetailValues[TagDetailField] {
  switch (field) {
    case 'address':
      return a.text.trim() || null
    case 'position':
      return a.latitude !== null && a.longitude !== null
        ? { latitude: a.latitude, longitude: a.longitude }
        : null
    case 'radius_metres':
      return a.radius
    case 'auto_match':
      return null // a flag has no third value: the dialog offers only the two sides
    case 'merchant_id':
    case 'default_category_id':
      return a.link
    case 'start_date':
    case 'end_date':
      return toIso(a.date)
  }
}

/** Why the answer cannot be used yet, or undefined. */
export function answerError(field: TagDetailField, a: Answer): string | undefined {
  if (a.choice === null) return 'Choose one.'
  if (a.choice === 'other' && field === 'position') return positionError(a.latitude, a.longitude)
  if (a.choice === 'other' && field === 'radius_metres') return radiusError(a.radius)
  return undefined
}
