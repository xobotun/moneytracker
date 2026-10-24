import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getAccountsRepository, getTransactionsRepository } from '@/db/init'
import type { Account } from '@/db/types'
import type { AccountCreateInput, AccountUpdateInput } from '@/db/repositories/AccountsRepository'
import type { UUID } from '@/db/uuid'

/**
 * Accounts (shown as "wallets" in the UI), in list order.
 *
 * Write-through, like all financial data: every change is persisted first and
 * the list is then re-read from SQLite, so the state never shows something the
 * database does not hold. A failed write rethrows and leaves the state as it
 * was. Re-reading the whole list is fine at wallet scale (a handful of rows).
 */
export const useAccountsStore = defineStore('accounts', () => {
  const accounts = ref<Account[]>([])
  const loaded = ref(false)

  async function load(): Promise<void> {
    accounts.value = await getAccountsRepository().list()
    loaded.value = true
  }

  async function create(input: AccountCreateInput): Promise<Account> {
    const account = await getAccountsRepository().create(input)
    await load()
    return account
  }

  async function update(id: UUID, patch: AccountUpdateInput): Promise<void> {
    await getAccountsRepository().update(id, patch)
    await load()
  }

  /** Moves account `id` to position `toIndex` (clamped into the list). */
  async function move(id: UUID, toIndex: number): Promise<void> {
    const ids = accounts.value.map((a) => a.id)
    const from = ids.indexOf(id)
    if (from === -1) return
    const to = Math.min(Math.max(toIndex, 0), ids.length - 1)
    if (from === to) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    await getAccountsRepository().reorder(ids)
    await load()
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

  return { accounts, loaded, load, create, update, move, remove }
})
