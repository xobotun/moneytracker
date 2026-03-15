/**
 * A typed settings key. Carries the string key and the value type together,
 * so callers don't need to specify generics at every get/set call site.
 *
 * Usage:
 *   const NAV_POSITION = settingsKey<NavPosition>('layout.navPosition')
 *   await repo.get(NAV_POSITION)  // returns NavPosition | null
 *   await repo.set(NAV_POSITION, 'left')  // type-checked
 */
export interface SettingsKey<T> {
  readonly key: string
  /** Phantom field for type branding — never set at runtime. */
  readonly __type?: T
}

export function settingsKey<T>(key: string): SettingsKey<T> {
  return { key } as SettingsKey<T>
}
