import { PRIME_ICONS } from './primeIcons'
import { setIcon, type Icon, type SetIcon } from './types'

// Icon packs, registered in code (docs/plans/2026-10-28-icons-design.md §2).
// Adding one is a new entry here (its CSS loaded where it is drawn); the data
// does not change. An icon of a set or name this build does not know draws as
// its owner's default icon.

export interface IconSet {
  /** Stored in `SetIcon.set`; never change it. */
  id: string
  label: string
  /** Every icon name, alphabetically. */
  names: readonly string[]
  /** The CSS class that draws `name`. */
  className(name: string): string
}

export const PRIME_ICON_SET: IconSet = {
  id: 'pi',
  label: 'PrimeIcons',
  names: PRIME_ICONS,
  className: (name) => `pi pi-${name}`,
}

export const ICON_SETS: readonly IconSet[] = [PRIME_ICON_SET]

const NAMES = new Map(ICON_SETS.map((set) => [set.id, new Set(set.names)]))
const SETS = new Map(ICON_SETS.map((set) => [set.id, set]))

/** The CSS class of a pack icon, or null when this build does not know its set or name. */
export function setIconClass(icon: SetIcon): string | null {
  const set = SETS.get(icon.set)
  return set && NAMES.get(icon.set)!.has(icon.name) ? set.className(icon.name) : null
}

/** A PrimeIcons icon. */
export const primeIcon = (name: string): SetIcon => setIcon(PRIME_ICON_SET.id, name)

/** Whether `icon` is the PrimeIcons icon `name`. */
export const isPrimeIcon = (icon: Icon, name: string): boolean =>
  icon.kind === 'set' && icon.set === PRIME_ICON_SET.id && icon.name === name

/** PrimeIcons shown right in the edit dialogs; any other icon is picked from the full list. */
export const QUICK_ICONS = [
  'wallet',
  'credit-card',
  'building-columns',
  'money-bill',
  'bitcoin',
  'ethereum',
  'paypal',
  'briefcase',
  'home',
  'shopping-bag',
  'gift',
  'car',
  'globe',
  'mobile',
  'chart-line',
  'star',
  'heart',
] as const

/** Readable name of an icon, for labels and tooltips: 'credit-card' → 'credit card'. */
export function iconLabel(icon: Icon): string {
  switch (icon.kind) {
    case 'set':
      return icon.name === 'building-columns' ? 'bank' : icon.name.replace(/-/g, ' ')
    case 'emoji':
      return icon.emoji
    case 'image':
      return 'picture'
    case 'unknown':
      return 'unknown icon'
  }
}
