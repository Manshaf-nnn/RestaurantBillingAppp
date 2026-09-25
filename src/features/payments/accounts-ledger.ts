import 'server-only'

import type { PaymentAccountEntry, PaymentAccountEntryType, Prisma } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { guardLocks, prisma, type TxClient } from '@/server/db/prisma'
import { destinationCodeForMethod, type PaymentConfig } from './destinations'

/**
 * The one place an internal account's money moves (bank.md).
 *
 * ── The balance is derived, never stored ────────────────────────────────────
 *
 * There is no `balance` column, and that is the whole design. bank.md §3 asks
 * that "account balance and transaction history must always reconcile", and
 * the only way to guarantee that rather than check it nightly is for the
 * balance to BE the history:
 *
 *   balance = Σ deposits + Σ transfers in − Σ transfers out
 *           + Σ payments stamped with this account − Σ refunds stamped with it
 *
 * Note what is missing from the entries table: a customer payment. A payment is
 * ALREADY attributed to an account by `Payment.destination`, stamped by
 * `capturePayment` and inherited by `refundPayment`. Writing a second row for
 * it here would give the same rupees two records that disagree the first time a
 * payment is refunded or voided — which is precisely the reasoning this
 * codebase already wrote into `enum CashMovementType` for why it has no
 * CASH_SALE member, and why `computeDrawerTotals` aggregates payments at read
 * time instead.
 *
 * So `capturePayment` and `refundPayment` are untouched by this feature. Money
 * lands in the right account the moment they commit, because the balance is a
 * question asked of them.
 *
 * ── What this module DOES write ─────────────────────────────────────────────
 *
 * Deposits and transfers, the only two facts with nowhere else to live, and the
 * only two ways bank.md §6 allows money to enter or move. `postAccountEntry` is
 * the sole writer, in the shape `postMovement` established for stock: it takes
 * a transaction it never opens, locks the row it is about to read, and refuses
 * anything it cannot account for.
 */

/**
 * Which way an entry moves money.
 *
 * An unknown type throws rather than defaulting to +1. A member added later
 * that silently ADDS money would be invisible until somebody reconciled a real
 * bank statement — the same reason `directionOf` in the stock ledger refuses.
 */
export function directionOf(type: PaymentAccountEntryType): 1 | -1 {
  switch (type) {
    case 'DEPOSIT':
    case 'TRANSFER_IN':
      return 1
    case 'TRANSFER_OUT':
      return -1
    default: {
      const unreachable: never = type
      throw new AppError(
        `Unknown account movement type: ${String(unreachable)}`,
        500,
        'ACCOUNT_ENTRY_TYPE',
      )
    }
  }
}

export interface AccountBalance {
  accountId: string
  code: string
  name: string
  /** Minor units. May be negative only where a refund outran the deposits. */
  balance: number
  /** The parts, so a screen can explain the number rather than assert it. */
  deposited: number
  transferredIn: number
  transferredOut: number
  collected: number
  refunded: number
}

/**
 * What every account holds, right now.
 *
 * ── Restaurant-wide, deliberately ───────────────────────────────────────────
 *
 * No branch filter. BOC holds what BOC holds; there is no such thing as
 * "Kandy's half of BOC". Deposits and transfers have no branch at all, and
 * narrowing the payments half by branch would produce a CONTRIBUTION — a number
 * that could never match the bank, sitting under a label that says "Balance".
 *
 * Five aggregates rather than one, because the money has two homes: the
 * entries this feature writes, and the payments that were already stamped with
 * an account long before it existed.
 */
export async function accountBalances(
  db: TxClient | typeof prisma,
  restaurantId: string,
): Promise<AccountBalance[]> {
  const [accounts, entries, payments, refunds] = await Promise.all([
    db.paymentAccount.findMany({
      where: { restaurantId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: { id: true, code: true, name: true },
    }),
    db.paymentAccountEntry.groupBy({
      by: ['accountId', 'type'],
      where: { restaurantId },
      _sum: { amount: true },
    }),
    /*
     * PAID and REFUNDED both count as collected, and the refunds are then
     * subtracted — the same basis `getDestinationTotals` has always used. A
     * fully refunded payment really was taken, and really was given back;
     * dropping it from one side would leave the other unbalanced.
     */
    db.payment.groupBy({
      by: ['destination'],
      where: { restaurantId, status: { in: ['PAID', 'REFUNDED'] }, destination: { not: null } },
      _sum: { amount: true },
    }),
    db.refund.groupBy({
      by: ['destination'],
      where: { restaurantId, destination: { not: null } },
      _sum: { amount: true },
    }),
  ])

  const byType = new Map<string, number>()
  for (const row of entries) byType.set(`${row.accountId}:${row.type}`, row._sum.amount ?? 0)
  const paid = new Map(payments.map((row) => [row.destination, row._sum.amount ?? 0]))
  const back = new Map(refunds.map((row) => [row.destination, row._sum.amount ?? 0]))

  return accounts.map((account) => {
    const deposited = byType.get(`${account.id}:DEPOSIT`) ?? 0
    const transferredIn = byType.get(`${account.id}:TRANSFER_IN`) ?? 0
    const transferredOut = byType.get(`${account.id}:TRANSFER_OUT`) ?? 0
    const collected = paid.get(account.code) ?? 0
    const refunded = back.get(account.code) ?? 0
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      balance: deposited + transferredIn - transferredOut + collected - refunded,
      deposited,
      transferredIn,
      transferredOut,
      collected,
      refunded,
    }
  })
}

/** One account's balance, for a check inside a transaction. */
export async function balanceOf(
  db: TxClient | typeof prisma,
  params: { restaurantId: string; accountId: string },
): Promise<number> {
  const all = await accountBalances(db, params.restaurantId)
  const found = all.find((row) => row.accountId === params.accountId)
  if (!found) throw new NotFoundError('Account')
  return found.balance
}

/**
 * Lock one or more accounts for the rest of the transaction.
 *
 * ── Why the caller locks, and why in one statement ──────────────────────────
 *
 * A transfer touches two accounts. If each `postAccountEntry` took its own
 * lock, the out-leg and the in-leg would be locked in (from, to) order — and a
 * simultaneous transfer the other way would take them in (to, from) order and
 * deadlock. Taking both in ONE statement, `ORDER BY id`, means every caller
 * everywhere acquires them in the same order, so the second transfer waits
 * instead of dying.
 *
 * Postgres releases these on commit or rollback, so a crashed request cannot
 * strand an account.
 */
export async function lockAccounts(
  tx: TxClient,
  params: { restaurantId: string; accountIds: string[] },
): Promise<void> {
  const ids = [...new Set(params.accountIds)].filter(Boolean)
  if (ids.length === 0) return

  await guardLocks(tx)
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM payment_accounts
     WHERE id = ANY(${ids}::text[]) AND "restaurantId" = ${params.restaurantId}
     ORDER BY id
       FOR UPDATE
  `
  if (locked.length !== ids.length) throw new NotFoundError('Account')
}

/**
 * The account a method's money lands in, as a real row.
 *
 * ── Why this replaced a lookup in a JSON blob ───────────────────────────────
 *
 * `destinationForMethod` used to answer this out of `paymentConfig`, which was
 * fine while an account was a label. Now it is a row with a balance and a staff
 * list, so the mapping has to resolve to one — a method pointed at a code with
 * no account behind it means money would land nowhere, and `capturePayment`
 * refuses rather than recording it loose.
 *
 * A RETIRED account is not a destination either. That is what stops one being
 * retired out from under a till mid-service, and it is inherited from the
 * `archived` check this replaced.
 */
export async function accountForMethod(
  db: TxClient | typeof prisma,
  params: { restaurantId: string; method: string; config: PaymentConfig },
): Promise<{ id: string; code: string; name: string } | null> {
  const code = destinationCodeForMethod(params.config, params.method)
  if (!code) return null

  const found = await db.paymentAccount.findFirst({
    where: { restaurantId: params.restaurantId, code, isActive: true },
    select: { id: true, code: true, name: true },
  })
  if (found) return found

  /*
   * A restaurant with NO accounts at all keeps trading.
   *
   * `readPaymentConfig` has always handed an unconfigured restaurant a default
   * book of accounts, for a reason it states plainly: "never opened the
   * setting" must not be the same state as "switched a method off". Promoting
   * accounts to rows would have quietly broken that guarantee — a restaurant
   * with no rows could take no money at all.
   *
   * The migration created rows for every restaurant that existed and
   * registration creates them for every new one, so in practice this fires
   * only for a restaurant that has somehow lost all of them. Seeding is
   * idempotent and cheaper than the alternative, which is a till refusing a
   * guest's cash because of a setting nobody knew they had to open.
   *
   * It does NOT fire when accounts exist and this code simply is not one of
   * them: that is a real misconfiguration and the caller refuses it.
   */
  const any = await db.paymentAccount.count({ where: { restaurantId: params.restaurantId } })
  if (any > 0) return null

  const { seedDefaultAccounts } = await import('./accounts')
  await seedDefaultAccounts(db, params.restaurantId)

  return db.paymentAccount.findFirst({
    where: { restaurantId: params.restaurantId, code, isActive: true },
    select: { id: true, code: true, name: true },
  })
}

export interface PostEntryParams {
  restaurantId: string
  accountId: string
  type: PaymentAccountEntryType
  /** Minor units, positive. The type decides the direction. */
  amount: number
  reason?: string | null
  counterpartyAccountId?: string | null
  transferGroupId?: string | null
  userId?: string | null
  actorName?: string | null
  clientRequestId?: string | null
}

/**
 * Write one movement. The only function that may.
 *
 * Takes a transaction it does not open, exactly like `postMovement`: a deposit
 * opens its own, and a transfer needs both legs and the balance check inside
 * one, so the choice belongs to the caller. The caller must have called
 * `lockAccounts` first — for a single-account deposit that is one id, for a
 * transfer it is both.
 */
export async function postAccountEntry(
  tx: TxClient,
  params: PostEntryParams,
): Promise<PaymentAccountEntry> {
  const amount = Math.round(params.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError('Enter an amount greater than zero', 400, 'ACCOUNT_AMOUNT')
  }

  const account = await tx.paymentAccount.findFirst({
    where: { id: params.accountId, restaurantId: params.restaurantId },
    select: { id: true, isActive: true, name: true },
  })
  if (!account) throw new NotFoundError('Account')

  /*
   * A retired account takes no new money. It keeps everything it already holds
   * and its history stays readable — retiring is not deleting — but pointing
   * fresh money at it is how an account nobody watches quietly accumulates.
   *
   * Money may still leave one, so a mistake can be transferred back out.
   */
  if (!account.isActive && directionOf(params.type) > 0) {
    throw new AppError(
      `${account.name} is retired. Move money into an account that is still in use.`,
      409,
      'ACCOUNT_RETIRED',
    )
  }

  return tx.paymentAccountEntry.create({
    data: {
      restaurantId: params.restaurantId,
      accountId: params.accountId,
      type: params.type,
      amount,
      reason: params.reason?.trim() || null,
      counterpartyAccountId: params.counterpartyAccountId ?? null,
      transferGroupId: params.transferGroupId ?? null,
      userId: params.userId ?? null,
      actorName: params.actorName ?? null,
      clientRequestId: params.clientRequestId ?? null,
    },
  })
}

/**
 * A retry of something that already happened.
 *
 * Read INSIDE the caller's transaction, after the account lock, so a genuinely
 * concurrent pair of same-key requests serialises on the lock and the loser
 * sees the winner's row rather than racing it. The unique index on
 * (restaurantId, clientRequestId) is the backstop if anything ever reaches the
 * insert without passing here — the same two-layer shape `capturePayment` uses.
 */
export async function findReplay(
  tx: TxClient,
  params: { restaurantId: string; clientRequestId?: string | null },
): Promise<PaymentAccountEntry | null> {
  if (!params.clientRequestId) return null
  return tx.paymentAccountEntry.findFirst({
    where: { restaurantId: params.restaurantId, clientRequestId: params.clientRequestId },
  })
}

export type { Prisma }
