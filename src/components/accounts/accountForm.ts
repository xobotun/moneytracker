import { moneyAmount, zeroMoney } from '@/db/MoneyAmount'
import type { Account } from '@/db/types'
import type { AccountCreateInput, AccountUpdateInput } from '@/db/repositories/AccountsRepository'
import { currencyCodeError, normaliseCurrencyCode } from '@/format/currency'
import { COLOUR_PRESETS } from '@/format/colours'
import type { ShortId } from '@/db/shortId'
import { PRIME_ICONS } from './primeIcons'

// Form logic of the account editor, kept out of the component so it can be
// tested without mounting PrimeVue.

/**
 * Icons shown right in the editor; any other PrimeIcons name can be picked
 * from the full list. Stored without the `pi-` prefix.
 */
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

const DEFAULT_ACCOUNT_ICON = 'wallet'

/**
 * What the editor edits. `currency` is the free-form money currency tag;
 * `tags` are tag names — the account stores plain-tag ids, resolved on save.
 */
export interface AccountDraft {
  name: string
  currency: string
  icon: string
  colour: string
  tags: string[]
  is_cash: boolean
}

export interface AccountDraftErrors {
  name?: string
  currency?: string
}

const KNOWN_ICONS = new Set(PRIME_ICONS)

/** CSS class for a stored icon name. Unknown names fall back to the wallet icon. */
export function accountIconClass(icon: string): string {
  return `pi pi-${KNOWN_ICONS.has(icon) ? icon : DEFAULT_ACCOUNT_ICON}`
}

/** Readable name of an icon, for labels and tooltips: 'credit-card' → 'credit card'. */
export function iconLabel(icon: string): string {
  return icon === 'building-columns' ? 'bank' : icon.replace(/-/g, ' ')
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

/** The currencies `accounts` use, most used first (ties in list order). */
export function currenciesByUse(accounts: readonly Account[]): string[] {
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
    colour: COLOUR_PRESETS[existing.length % COLOUR_PRESETS.length]!,
    tags: [],
    is_cash: false,
  }
}

/**
 * `tagName` gives the name to edit for a tag id, or null for a tag that is
 * deleted or unknown: it is left out of the draft (see `hiddenTagIds`).
 */
export function draftFromAccount(
  account: Account,
  tagName: (id: ShortId) => string | null,
): AccountDraft {
  return {
    name: account.name,
    currency: account.balance.currency,
    icon: account.icon,
    colour: account.colour,
    tags: account.tags.map(tagName).filter((name): name is string => name !== null),
    is_cash: account.is_cash,
  }
}

/**
 * The account's tag ids the draft leaves out (`tagName` null: deleted, or
 * unknown because the tags could not be loaded). Saving keeps them: a
 * restored tag comes back on the account (decisions §2.5).
 */
export function hiddenTagIds(account: Account, tagName: (id: ShortId) => string | null): ShortId[] {
  return account.tags.filter((id) => tagName(id) === null)
}

/**
 * The tag ids to save: the stored ones still wanted (hidden, or among
 * `resolved` — the ids of the draft's names) in their stored order, then the
 * new ones in `resolved` order, each once. An untouched draft gives the
 * stored list back unchanged.
 */
export function tagIdsToSave(
  stored: readonly ShortId[],
  resolved: readonly ShortId[],
  hidden: readonly ShortId[],
): ShortId[] {
  const kept = stored.filter((id) => hidden.includes(id) || resolved.includes(id))
  return [...new Set([...kept, ...resolved])]
}

export function validateDraft(draft: AccountDraft): AccountDraftErrors {
  const errors: AccountDraftErrors = {}
  if (draft.name.trim() === '') errors.name = 'Give the account a name.'
  const currency = currencyCodeError(draft.currency)
  if (currency) errors.currency = currency
  return errors
}

export function normaliseDraft(draft: AccountDraft): AccountDraft {
  return {
    name: draft.name.trim(),
    currency: normaliseCurrencyCode(draft.currency),
    icon: draft.icon,
    colour: draft.colour,
    tags: [...new Set(draft.tags.map((t) => t.trim()).filter((t) => t !== ''))],
    is_cash: draft.is_cash,
  }
}

/**
 * A new account starts at zero; money already on it is entered as income. It
 * joins no group (it shows below them); groups are arranged in reorder mode.
 */
export function createInputFromDraft(draft: AccountDraft, tagIds: ShortId[]): AccountCreateInput {
  return {
    name: draft.name,
    balance: zeroMoney(draft.currency),
    is_cash: draft.is_cash,
    tags: tagIds,
    location_id: null,
    colour: draft.colour,
    icon: draft.icon,
    grouping_id: null,
  }
}

/** Only the fields that changed, so an untouched save writes nothing. */
export function patchFromDraft(
  account: Account,
  draft: AccountDraft,
  tagIds: ShortId[],
): AccountUpdateInput {
  const patch: AccountUpdateInput = {}
  if (draft.name !== account.name) patch.name = draft.name
  if (draft.currency !== account.balance.currency) {
    patch.balance = moneyAmount(account.balance.value, account.balance.scale, draft.currency)
  }
  if (draft.icon !== account.icon) patch.icon = draft.icon
  if (draft.colour !== account.colour) patch.colour = draft.colour
  if (draft.is_cash !== account.is_cash) patch.is_cash = draft.is_cash
  if (tagIds.join(',') !== account.tags.join(',')) patch.tags = tagIds
  return patch
}
