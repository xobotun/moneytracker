import { expect } from 'vitest'
import type { CategoryPart } from '../../../db/types'
import type { ShortId } from '../../../db/shortId'
import type { UUID } from '../../../db/uuid'
import { moneyAmount, sumMoney, type MoneyAmount } from '../../../db/MoneyAmount'
import { localMoment } from '../../../db/LocalMoment'
import type { Device } from '../devices'

// Data the corner-case scenarios create through the repositories, and the
// invariants every device must hold after a sync (decisions §2.2, §2.5).

export const usd = (value: number, scale = 2): MoneyAmount => moneyAmount(value, scale, 'USD')

/** A category part in USD on both sides. */
export const part = (category: ShortId, value: number, scale = 2): CategoryPart => ({
  category_id: category,
  amount__from: usd(value, scale),
  amount__to: usd(value, scale),
})

export async function openAccount(device: Device, name: string): Promise<ShortId> {
  const account = await device.accounts.create({
    name,
    balance: usd(0),
    tags: [],
    location_id: null,
    colour: '#000000',
    icon: 'wallet',
    grouping_id: null,
  })
  return account.id
}

export interface MoveInput {
  from: ShortId | null
  to: ShortId | null
  parts: CategoryPart[]
  tags?: ShortId[]
  merchant?: ShortId | null
  location?: ShortId | null
}

/** A USD transaction whose amount is the sum of its parts. */
export async function record(device: Device, input: MoveInput): Promise<UUID> {
  const amount = sumMoney(
    input.parts.map((p) => p.amount__from),
    'USD',
  )
  const created = await device.transactions.create({
    account_id__from: input.from,
    account_id__to: input.to,
    amount__from: amount,
    amount__to: amount,
    transaction_at: localMoment('2026-05-01T09:00:00.000+00:00', 'UTC'),
    date_override: null,
    tags: input.tags ?? [],
    categories: input.parts,
    merchant_id: input.merchant ?? null,
    location_lat: null,
    location_lon: null,
    location_id: input.location ?? null,
  })
  return created.id
}

/** The live transaction's category parts as [category, value from, scale from]. */
export async function partsOf(device: Device, id: UUID): Promise<[string, number, number][]> {
  const t = await device.transactions.findById(id)
  return t!.categories.map((p) => [p.category_id, p.amount__from.value, p.amount__from.scale])
}

export async function tagRow(device: Device, id: string): Promise<Record<string, unknown>> {
  return (await device.db.exec('SELECT * FROM tags WHERE id = ?', [id]))[0]!
}

interface TagNode {
  id: string
  kind: string
  parent_id: string | null
  merged_into_id: string | null
  deleted_at_utc: string | null
}

/**
 * What the repair guarantees for the tags: a live tag sits under a live tag
 * of its kind (or at the top), parents form no loop, a merged tag is deleted
 * and its merge chain ends at an unmerged tag, and nothing refers to a merged
 * tag any more (the references were redirected to the chain's end).
 */
export async function expectTagInvariants(device: Device): Promise<void> {
  const rows = await device.db.exec<TagNode & Record<string, unknown>>(
    'SELECT id, kind, parent_id, merged_into_id, deleted_at_utc FROM tags',
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const problems: string[] = []
  for (const tag of rows) {
    if (tag.merged_into_id !== null) {
      if (tag.deleted_at_utc === null) problems.push(`${tag.id} is merged but live`)
      const seen = new Set<string>()
      for (let id: string | null = tag.id; id !== null; id = byId.get(id)!.merged_into_id) {
        if (seen.has(id)) {
          problems.push(`${tag.id} is in a merge cycle`)
          break
        }
        seen.add(id)
      }
    }
    if (tag.deleted_at_utc !== null || tag.parent_id === null) continue
    const parent = byId.get(tag.parent_id)
    if (!parent || parent.deleted_at_utc !== null || parent.kind !== tag.kind) {
      problems.push(`${tag.id} is under ${tag.parent_id}, not a live ${tag.kind}`)
      continue
    }
    const seen = new Set<string>()
    for (let id: string | null = tag.id; id !== null; id = byId.get(id)?.parent_id ?? null) {
      if (seen.has(id)) {
        problems.push(`${tag.id} is in a parent loop`)
        break
      }
      seen.add(id)
    }
  }
  const merged = new Set(rows.filter((r) => r.merged_into_id !== null).map((r) => r.id))
  for (const [where, id] of await tagReferences(device)) {
    if (merged.has(id)) problems.push(`${where} refers to the merged ${id}`)
  }
  expect(problems, device.name).toEqual([])
}

/** Every tag id stored outside the tags table, with where it is. */
async function tagReferences(device: Device): Promise<[string, string][]> {
  const refs: [string, string][] = []
  const transactions = await device.db.exec<{
    id: string
    merchant_id: string | null
    location_id: string | null
    journey_id: string | null
    tags: string
    categories: string
  }>('SELECT id, merchant_id, location_id, journey_id, tags, categories FROM transactions')
  for (const t of transactions) {
    for (const id of [t.merchant_id, t.location_id, t.journey_id]) {
      if (id !== null) refs.push([`transaction ${t.id}`, id])
    }
    for (const id of JSON.parse(t.tags) as string[]) refs.push([`transaction ${t.id}`, id])
    for (const p of JSON.parse(t.categories) as { category_id: string }[]) {
      refs.push([`transaction ${t.id}`, p.category_id])
    }
  }
  const accounts = await device.db.exec<{ id: string; location_id: string | null; tags: string }>(
    'SELECT id, location_id, tags FROM accounts',
  )
  for (const a of accounts) {
    if (a.location_id !== null) refs.push([`account ${a.id}`, a.location_id])
    for (const id of JSON.parse(a.tags) as string[]) refs.push([`account ${a.id}`, id])
  }
  const sideLinks = await device.db.exec<{ tag_id: string; link: string }>(
    `SELECT tag_id, merchant_id AS link FROM location_details WHERE merchant_id IS NOT NULL
     UNION ALL
     SELECT tag_id, default_category_id FROM merchant_details WHERE default_category_id IS NOT NULL`,
  )
  for (const s of sideLinks) refs.push([`details of ${s.tag_id}`, s.link])
  return refs
}

/**
 * The rules of a live transaction's category parts (decisions §2.2, §2.4):
 * at least one, each category once and a category tag, each side adding up
 * exactly to the transaction's amount.
 */
export async function expectTransactionInvariants(device: Device): Promise<void> {
  const kinds = new Map(
    (await device.db.exec<{ id: string; kind: string }>('SELECT id, kind FROM tags')).map((r) => [
      r.id,
      r.kind,
    ]),
  )
  const problems: string[] = []
  for (const t of await device.transactions.list()) {
    const ids = t.categories.map((p) => p.category_id)
    if (ids.length === 0) problems.push(`${t.id} has no category part`)
    if (new Set(ids).size !== ids.length) problems.push(`${t.id} has a category twice`)
    for (const id of ids) {
      if (kinds.get(id) !== 'category') problems.push(`${t.id}: ${id} is not a category`)
    }
    for (const side of ['from', 'to'] as const) {
      const total = side === 'from' ? t.amount__from : t.amount__to
      const sum = sumMoney(
        t.categories.map((p) => (side === 'from' ? p.amount__from : p.amount__to)),
        total.currency,
      )
      if (units(sum, 20) !== units(total, 20)) {
        problems.push(`${t.id}: the ${side} parts add up to ${sum.value}e-${sum.scale}`)
      }
    }
  }
  expect(problems, device.name).toEqual([])
}

/** Live transactions none of whose categories is a live tag ("every transaction has a category", §2.2). */
export async function transactionsWithoutLiveCategory(device: Device): Promise<string[]> {
  const rows = await device.db.exec<{ id: string }>(
    `SELECT t.id FROM transactions t
     WHERE t.deleted_at_utc IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM json_each(t.categories) AS p
         JOIN tags c ON c.id = json_extract(p.value, '$.category_id')
         WHERE c.deleted_at_utc IS NULL)`,
  )
  return rows.map((r) => r.id)
}

const units = (m: MoneyAmount, scale: number) => BigInt(m.value) * 10n ** BigInt(scale - m.scale)

/**
 * Each account's cached balance equals what arrived minus what left in its
 * live transactions, in its currency — checked here independently of
 * `recalculateBalances`. The database hash ignores the cache, so convergence
 * alone says nothing about it.
 */
export async function expectBalancesMatchTransactions(device: Device): Promise<void> {
  const accounts = await device.db.exec<{
    id: string
    currency: string
    balance_value: number
    balance_scale: number
  }>('SELECT id, currency, balance_value, balance_scale FROM accounts')
  const legs = await device.db.exec<{
    from_id: string | null
    to_id: string | null
    vf: number
    sf: number
    cf: string
    vt: number
    st: number
    ct: string
  }>(
    `SELECT account_id__from AS from_id, account_id__to AS to_id,
            amount_value__from AS vf, amount_scale__from AS sf, amount_currency__from AS cf,
            amount_value__to AS vt, amount_scale__to AS st, amount_currency__to AS ct
     FROM transactions WHERE deleted_at_utc IS NULL`,
  )
  const actual: Record<string, bigint> = {}
  const expected: Record<string, bigint> = {}
  for (const a of accounts) {
    actual[a.id] = units(moneyAmount(a.balance_value, a.balance_scale, a.currency), 20)
    let sum = 0n
    for (const l of legs) {
      if (l.to_id === a.id && l.ct === a.currency) sum += units(usd(l.vt, l.st), 20)
      if (l.from_id === a.id && l.cf === a.currency) sum -= units(usd(l.vf, l.sf), 20)
    }
    expected[a.id] = sum
  }
  expect(actual, `${device.name}'s cached balances`).toEqual(expected)
}

/** Each account's cached balance as [value, scale]. */
export async function balances(device: Device): Promise<Record<string, [number, number]>> {
  const rows = await device.db.exec<{ id: string; balance_value: number; balance_scale: number }>(
    'SELECT id, balance_value, balance_scale FROM accounts ORDER BY id',
  )
  return Object.fromEntries(rows.map((r) => [r.id, [r.balance_value, r.balance_scale]]))
}

/** Every invariant above, on every device. */
export async function expectSound(devices: Device[]): Promise<void> {
  for (const device of devices) {
    await expectTagInvariants(device)
    await expectTransactionInvariants(device)
    await expectBalancesMatchTransactions(device)
  }
}
