import { moneyAmount, zeroMoney } from '@/db/MoneyAmount'
import type { Account } from '@/db/types'
import type { AccountCreateInput, AccountUpdateInput } from '@/db/repositories/AccountsRepository'

// Form logic of the account editor, kept out of the component so it can be
// tested without mounting PrimeVue.

/** PrimeIcons names (stored without the `pi-` prefix) offered for an account. */
export const ACCOUNT_ICONS = [
  'wallet',
  'credit-card',
  'building-columns',
  'money-bill',
  'dollar',
  'euro',
  'pound',
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

const DEFAULT_ACCOUNT_ICON = 'wallet'

/** Preset swatches (Tailwind 500 shades); any other colour can be picked too. */
export const ACCOUNT_COLOURS = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#14b8a6',
  '#ec4899',
  '#f97316',
  '#6366f1',
  '#64748b',
] as const

/** Names of the preset swatches, for their accessible labels. */
export const ACCOUNT_COLOUR_NAMES: Record<(typeof ACCOUNT_COLOURS)[number], string> = {
  '#3b82f6': 'blue',
  '#22c55e': 'green',
  '#f59e0b': 'amber',
  '#ef4444': 'red',
  '#a855f7': 'purple',
  '#14b8a6': 'teal',
  '#ec4899': 'pink',
  '#f97316': 'orange',
  '#6366f1': 'indigo',
  '#64748b': 'slate',
}

/** What the editor edits. `currency` is the free-form money currency tag. */
export interface AccountDraft {
  name: string
  currency: string
  icon: string
  colour: string
  tags: string[]
}

export interface AccountDraftErrors {
  name?: string
  currency?: string
}

/** CSS class for a stored icon name. Unknown names fall back to the wallet icon. */
export function accountIconClass(icon: string): string {
  const known = (ACCOUNT_ICONS as readonly string[]).includes(icon)
  return `pi pi-${known ? icon : DEFAULT_ACCOUNT_ICON}`
}

function relativeLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const digits = m[1]!.length === 3 ? [...m[1]!].map((d) => d + d).join('') : m[1]!
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/**
 * Icon colour for an account badge: white while it keeps the 3:1 contrast WCAG
 * asks of graphics, dark ink on light colours (yellow, teal, …) otherwise.
 */
export function iconColourOn(background: string): string {
  const l = relativeLuminance(background)
  if (l === null) return '#ffffff'
  return 1.05 / (l + 0.05) >= 3 ? '#ffffff' : '#111827'
}

function currenciesByUse(accounts: readonly Account[]): string[] {
  const counts = new Map<string, number>()
  for (const a of accounts)
    counts.set(a.balance.currency, (counts.get(a.balance.currency) ?? 0) + 1)
  // Map keeps insertion order and sort is stable, so ties stay in list order.
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([currency]) => currency)
}

/** Draft for a new account: the most used currency and the next palette colour. */
export function newAccountDraft(existing: readonly Account[]): AccountDraft {
  return {
    name: '',
    currency: currenciesByUse(existing)[0] ?? '',
    icon: DEFAULT_ACCOUNT_ICON,
    colour: ACCOUNT_COLOURS[existing.length % ACCOUNT_COLOURS.length]!,
    tags: [],
  }
}

export function draftFromAccount(account: Account): AccountDraft {
  return {
    name: account.name,
    currency: account.balance.currency,
    icon: account.icon,
    colour: account.colour,
    tags: [...account.tags],
  }
}

export function validateDraft(draft: AccountDraft): AccountDraftErrors {
  const errors: AccountDraftErrors = {}
  if (draft.name.trim() === '') errors.name = 'Give the account a name.'
  const currency = draft.currency.trim()
  if (currency === '') errors.currency = 'Enter a currency code, e.g. EUR or BTC.'
  else if (/\s/.test(currency)) errors.currency = 'A currency code has no spaces.'
  return errors
}

export function normaliseDraft(draft: AccountDraft): AccountDraft {
  return {
    name: draft.name.trim(),
    currency: draft.currency.trim().toUpperCase(),
    icon: draft.icon,
    colour: draft.colour,
    tags: [...new Set(draft.tags.map((t) => t.trim()).filter((t) => t !== ''))],
  }
}

/** A new account starts at zero; money already on it is entered as income. */
export function createInputFromDraft(draft: AccountDraft): AccountCreateInput {
  return {
    name: draft.name,
    balance: zeroMoney(draft.currency),
    tags: draft.tags,
    location_id: null,
    colour: draft.colour,
    icon: draft.icon,
  }
}

/** Only the fields that changed, so an untouched save writes nothing. */
export function patchFromDraft(account: Account, draft: AccountDraft): AccountUpdateInput {
  const patch: AccountUpdateInput = {}
  if (draft.name !== account.name) patch.name = draft.name
  if (draft.currency !== account.balance.currency) {
    patch.balance = moneyAmount(account.balance.value, account.balance.scale, draft.currency)
  }
  if (draft.icon !== account.icon) patch.icon = draft.icon
  if (draft.colour !== account.colour) patch.colour = draft.colour
  if (draft.tags.join('\u0000') !== account.tags.join('\u0000')) patch.tags = draft.tags
  return patch
}

// Intl.supportedValuesOf is ES2022, above the ES2020 lib the app is checked
// against (Vite's build target), and missing in older browsers.
const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'currency') => string[] }
const ISO_CURRENCIES: readonly string[] = intl.supportedValuesOf?.('currency') ?? []

/** Currency codes starting with `query`: those already in use first, then ISO 4217. */
export function currencySuggestions(query: string, accounts: readonly Account[]): string[] {
  const prefix = query.trim().toUpperCase()
  const used = currenciesByUse(accounts)
  return [...new Set([...used, ...ISO_CURRENCIES])].filter((c) => c.startsWith(prefix))
}
