/**
 * A civil moment anchored to an IANA zone.
 *
 * `local` is an offset-bearing ISO 8601 string (e.g. '2013-10-07T04:23:19.120+04:00')
 * that preserves the exact wall-clock the user saw plus the offset they were at.
 * `zone` is the IANA zone name (e.g. 'Europe/Berlin') — needed because the offset
 * alone doesn't identify the zone (DST, multi-zone offsets).
 */
export interface LocalMoment {
  readonly local: string
  readonly zone: string
}

export function localMoment(local: string, zone: string): LocalMoment {
  if (!local) throw new Error('LocalMoment local string must be non-empty')
  if (!zone) throw new Error('LocalMoment zone must be non-empty')
  return Object.freeze({ local, zone })
}
