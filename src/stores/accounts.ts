import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  getAccountGroupingsRepository,
  getAccountsRepository,
  getTransactionsRepository,
} from '@/db/init'
import type { Account, AccountGrouping } from '@/db/types'
import type { AccountCreateInput, AccountUpdateInput } from '@/db/repositories/AccountsRepository'
import type {
  AccountGroupingCreateInput,
  AccountGroupingUpdateInput,
} from '@/db/repositories/AccountGroupingsRepository'
import type { UUID } from '@/db/uuid'

/** One block of the accounts page: a group with its accounts, or (grouping null) the rest. */
export interface AccountSection {
  grouping: AccountGrouping | null
  accounts: Account[]
}

/**
 * Accounts and their groups, as the accounts page arranges them.
 *
 * Write-through, like all financial data: every change is persisted first and
 * the lists are then re-read from SQLite, so the state never shows something
 * the database does not hold. A failed write rethrows and leaves the state as
 * it was. Re-reading everything is fine at this scale (a handful of rows).
 */
export const useAccountsStore = defineStore('accounts', () => {
  const accounts = ref<Account[]>([])
  const groupings = ref<AccountGrouping[]>([])
  const loaded = ref(false)

  /**
   * Each live group with its accounts, in order, then a last section with the
   * accounts in no group — always present, even when empty. An account whose
   * group is deleted or missing (a sync merge can leave that) goes there too.
   */
  const sections = computed<AccountSection[]>(() => {
    const byGrouping = new Map<UUID, Account[]>(groupings.value.map((g) => [g.id, []]))
    const ungrouped: Account[] = []
    for (const account of accounts.value) {
      const members = account.grouping_id === null ? undefined : byGrouping.get(account.grouping_id)
      ;(members ?? ungrouped).push(account)
    }
    return [
      ...groupings.value.map((g) => ({ grouping: g, accounts: byGrouping.get(g.id)! })),
      { grouping: null, accounts: ungrouped },
    ]
  })

  async function load(): Promise<void> {
    const [accountList, groupingList] = await Promise.all([
      getAccountsRepository().list(),
      getAccountGroupingsRepository().list(),
    ])
    accounts.value = accountList
    groupings.value = groupingList
    loaded.value = true
  }

  // --- Accounts ---

  async function create(input: AccountCreateInput): Promise<Account> {
    const account = await getAccountsRepository().create(input)
    await load()
    return account
  }

  /**
   * Updates the account. A currency change is refused while live
   * transactions use it: their amounts are in the old currency, and the
   * balance would silently stop counting them.
   */
  async function update(id: UUID, patch: AccountUpdateInput): Promise<void> {
    const current = accounts.value.find((a) => a.id === id)
    if (patch.balance && current && patch.balance.currency !== current.balance.currency) {
      const used = (await getTransactionsRepository().listByAccountId(id)).length
      if (used > 0) {
        throw new Error(
          `Its currency cannot change: ${used} transaction${used === 1 ? ' uses' : 's use'} it in ${current.balance.currency}.`,
        )
      }
    }
    await getAccountsRepository().update(id, patch)
    await load()
  }

  /** Rebuilds every cached balance from the transactions; returns how many changed. */
  async function recalculateBalances(): Promise<number> {
    const changed = await getAccountsRepository().recalculateBalances()
    await load()
    return changed
  }

  /** Rebuilds one account's cached balance; returns whether it changed. */
  async function recalculateBalance(id: UUID): Promise<boolean> {
    const changed = await getAccountsRepository().recalculateBalances([id])
    await load()
    return changed > 0
  }

  /**
   * Soft-deletes the account. Refused while live transactions use it: a soft
   * delete skips the foreign-key check, so they would silently point at a
   * deleted account.
   */
  async function remove(id: UUID): Promise<void> {
    const used = (await getTransactionsRepository().listByAccountId(id)).length
    if (used > 0) {
      throw new Error(`It is still used by ${used} transaction${used === 1 ? '' : 's'}.`)
    }
    await getAccountsRepository().softDelete(id)
    await load()
  }

  /**
   * Puts account `id` into the section of `groupingId` (null = the ungrouped
   * accounts) at `index`, clamped into that section.
   */
  async function moveAccount(id: UUID, groupingId: UUID | null, index: number): Promise<void> {
    const target = sections.value.find((s) => (s.grouping?.id ?? null) === groupingId)
    if (!target) return
    const ids = target.accounts.map((a) => a.id).filter((other) => other !== id)
    ids.splice(Math.min(Math.max(index, 0), ids.length), 0, id)
    await getAccountsRepository().arrange(groupingId, ids)
    await load()
  }

  /**
   * Where one step up (-1) or down (+1) takes account `id`: the next place in
   * its section, or over the edge into the neighbouring section — the end of
   * the one above, the start of the one below. Null at the very start or end.
   */
  function stepTarget(id: UUID, step: -1 | 1): { groupingId: UUID | null; index: number } | null {
    const all = sections.value
    const sectionIndex = all.findIndex((s) => s.accounts.some((a) => a.id === id))
    if (sectionIndex === -1) return null
    const here = all[sectionIndex]!
    const index = here.accounts.findIndex((a) => a.id === id) + step
    if (index >= 0 && index < here.accounts.length) {
      return { groupingId: here.grouping?.id ?? null, index }
    }
    const next = all[sectionIndex + step]
    if (!next) return null
    return { groupingId: next.grouping?.id ?? null, index: step === 1 ? 0 : next.accounts.length }
  }

  function canMoveAccountBy(id: UUID, step: -1 | 1): boolean {
    return stepTarget(id, step) !== null
  }

  async function moveAccountBy(id: UUID, step: -1 | 1): Promise<void> {
    const target = stepTarget(id, step)
    if (target) await moveAccount(id, target.groupingId, target.index)
  }

  // --- Groups ---

  async function createGrouping(input: AccountGroupingCreateInput): Promise<AccountGrouping> {
    const grouping = await getAccountGroupingsRepository().create(input)
    await load()
    return grouping
  }

  async function updateGrouping(id: UUID, patch: AccountGroupingUpdateInput): Promise<void> {
    await getAccountGroupingsRepository().update(id, patch)
    await load()
  }

  /** Deletes the group; its accounts move below the groups and are kept. */
  async function removeGrouping(id: UUID): Promise<void> {
    await getAccountGroupingsRepository().softDelete(id)
    await load()
  }

  /** Moves group `id` to position `toIndex` (clamped) among the groups. */
  async function moveGrouping(id: UUID, toIndex: number): Promise<void> {
    const ids = groupings.value.map((g) => g.id)
    const from = ids.indexOf(id)
    if (from === -1) return
    const to = Math.min(Math.max(toIndex, 0), ids.length - 1)
    if (from === to) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    await getAccountGroupingsRepository().reorder(ids)
    await load()
  }

  return {
    accounts,
    groupings,
    loaded,
    sections,
    load,
    create,
    update,
    recalculateBalances,
    recalculateBalance,
    remove,
    moveAccount,
    moveAccountBy,
    canMoveAccountBy,
    createGrouping,
    updateGrouping,
    removeGrouping,
    moveGrouping,
  }
})
