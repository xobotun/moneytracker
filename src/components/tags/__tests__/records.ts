import type { Database } from '@/db/Database'
import { AccountsRepository } from '@/db/repositories/AccountsRepository'
import { TransactionsRepository } from '@/db/repositories/TransactionsRepository'
import { moneyAmount, zeroMoney } from '@/db/MoneyAmount'
import { localMoment } from '@/db/LocalMoment'
import type { ShortId } from '@/db/shortId'

// Rows that use tags, so the dialogs have uses to count.

/** A EUR account with the plain `tags`. */
export async function addAccount(db: Database, tags: ShortId[] = []): Promise<ShortId> {
  const account = await new AccountsRepository(db).create({
    name: 'Cash',
    balance: zeroMoney('EUR'),
    tags,
    location_id: null,
    grouping_id: null,
    colour: '#3b82f6',
    icon: 'wallet',
  })
  return account.id
}

/** Records a 5 € expense from `accountId` in `categoryId` with the plain `tags`. */
export async function spend(
  db: Database,
  accountId: ShortId,
  categoryId: ShortId,
  tags: ShortId[] = [],
): Promise<void> {
  const amount = moneyAmount(500, 2, 'EUR')
  await new TransactionsRepository(db).create({
    account_id__from: accountId,
    account_id__to: null,
    amount__from: amount,
    amount__to: amount,
    categories: [{ category_id: categoryId, amount__from: amount, amount__to: amount }],
    location_id: null,
    location_lat: null,
    location_lon: null,
    tags,
    transaction_at: localMoment('2026-07-01T12:00:00.000+02:00', 'Europe/Berlin'),
    date_override: null,
  })
}
