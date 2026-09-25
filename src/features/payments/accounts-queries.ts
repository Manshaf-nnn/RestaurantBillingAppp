import 'server-only'

import { ROLE_LABELS } from '@/lib/rbac'
import type { TenantUser } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { visibleAccountsFor } from './accounts'
import type { AccountCard, AccountAccessRow, StaffOption } from './components/accounts-panel'

/**
 * What the account screens read.
 *
 * Kept out of `accounts.ts` so that file stays about CHANGING money, and this
 * one about showing it — the same split `queries.ts` and `service.ts` already
 * have across this feature.
 */

/** The cards, already narrowed to what this person may see. */
export async function accountsForScreen(user: TenantUser): Promise<AccountCard[]> {
  const balances = await visibleAccountsFor(user)
  if (balances.length === 0) return []

  const details = await prisma.paymentAccount.findMany({
    where: { id: { in: balances.map((row) => row.accountId) } },
    select: { id: true, bankName: true, accountNumber: true, holderName: true, isActive: true },
  })
  const byId = new Map(details.map((row) => [row.id, row]))

  return balances.map((row) => {
    const detail = byId.get(row.accountId)
    return {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      bankName: detail?.bankName ?? null,
      /*
       * One line of whatever was filled in — "BOC · A/C 1234567 · Nimal".
       * Built from the parts that exist rather than a template with gaps, so an
       * account with no bank details describes itself as nothing rather than as
       * a row of separators.
       */
      detail:
        [detail?.bankName, detail?.accountNumber ? `A/C ${detail.accountNumber}` : null, detail?.holderName]
          .filter(Boolean)
          .join(' · ') || null,
      balance: row.balance,
      isActive: detail?.isActive ?? true,
    }
  })
}

/**
 * The staff an owner may assign, and who is already assigned.
 *
 * Owners and admins are left out: they already have full access to every
 * account and always will, so offering a tick box that changes nothing would be
 * a control that lies.
 */
export async function accountStaffOptions(
  user: TenantUser,
): Promise<{ staff: StaffOption[]; access: AccountAccessRow[] }> {
  const [people, rows] = await Promise.all([
    prisma.user.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        isActive: true,
        role: { notIn: ['OWNER', 'ADMIN', 'SUPER_ADMIN'] },
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, role: true },
    }),
    prisma.paymentAccountStaff.findMany({
      where: { account: { restaurantId: user.restaurantId } },
      select: { accountId: true, userId: true, canTransfer: true },
    }),
  ])

  return {
    staff: people.map((person) => ({
      id: person.id,
      name: person.name,
      roleLabel: ROLE_LABELS[person.role] ?? person.role,
    })),
    access: rows,
  }
}

export interface AccountTransactionRow {
  id: string
  at: string
  /** What a person would call it: Deposit, Transfer in, Payment, Refund. */
  type: string
  /** The account at the other end, or the order a payment settled. */
  counterparty: string | null
  /** Signed, minor units: what this movement did to THIS account. */
  amount: number
  reason: string | null
  actorName: string | null
  reference: string | null
  /** The balance after this movement, running from the oldest. */
  balanceAfter: number
}

/**
 * One account's complete history (bank.md §3).
 *
 * ── Why this is a merge and not a table read ────────────────────────────────
 *
 * The money has two homes: the deposits and transfers this feature writes, and
 * the payments that were already stamped with the account long before it
 * existed. Reading only the first would show an owner a history that does not
 * explain their own balance.
 *
 * The running balance is computed here, oldest first, rather than stored on
 * each row — which is what makes "balance and history always reconcile" true by
 * construction: the last row's balance IS the account's balance, because both
 * are the same sum.
 */
export async function accountTransactions(params: {
  restaurantId: string
  code: string
  limit?: number
}): Promise<AccountTransactionRow[]> {
  const account = await prisma.paymentAccount.findFirst({
    where: { restaurantId: params.restaurantId, code: params.code },
    select: { id: true },
  })

  const [entries, payments, refunds] = await Promise.all([
    account
      ? prisma.paymentAccountEntry.findMany({
          where: { accountId: account.id },
          orderBy: { createdAt: 'asc' },
          include: { counterpartyAccount: { select: { name: true } } },
        })
      : Promise.resolve([]),
    prisma.payment.findMany({
      where: {
        restaurantId: params.restaurantId,
        destination: params.code,
        status: { in: ['PAID', 'REFUNDED'] },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, amount: true, method: true, reference: true, paidAt: true, createdAt: true,
        order: { select: { orderNumber: true } },
        receivedBy: { select: { name: true } },
      },
    }),
    prisma.refund.findMany({
      where: { restaurantId: params.restaurantId, destination: params.code },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, amount: true, reason: true, createdAt: true,
        order: { select: { orderNumber: true } },
        refundedBy: { select: { name: true } },
      },
    }),
  ])

  type Row = Omit<AccountTransactionRow, 'balanceAfter'> & { sortAt: number }
  const merged: Row[] = [
    ...entries.map((entry) => ({
      id: entry.id,
      at: entry.createdAt.toISOString(),
      sortAt: entry.createdAt.getTime(),
      type:
        entry.type === 'DEPOSIT'
          ? 'Deposit'
          : entry.type === 'TRANSFER_IN'
            ? 'Transfer in'
            : 'Transfer out',
      counterparty: entry.counterpartyAccount?.name ?? null,
      amount: entry.type === 'TRANSFER_OUT' ? -entry.amount : entry.amount,
      reason: entry.reason,
      actorName: entry.actorName,
      reference: entry.transferGroupId ? entry.transferGroupId.slice(-8) : null,
    })),
    ...payments.map((payment) => ({
      id: payment.id,
      at: (payment.paidAt ?? payment.createdAt).toISOString(),
      sortAt: (payment.paidAt ?? payment.createdAt).getTime(),
      type: 'Payment',
      counterparty: payment.order?.orderNumber ? `Bill ${payment.order.orderNumber}` : null,
      amount: payment.amount,
      reason: payment.method,
      actorName: payment.receivedBy?.name ?? null,
      reference: payment.reference,
    })),
    ...refunds.map((refund) => ({
      id: refund.id,
      at: refund.createdAt.toISOString(),
      sortAt: refund.createdAt.getTime(),
      type: 'Refund',
      counterparty: refund.order?.orderNumber ? `Bill ${refund.order.orderNumber}` : null,
      amount: -refund.amount,
      reason: refund.reason,
      actorName: refund.refundedBy?.name ?? null,
      reference: null,
    })),
  ].sort((a, b) => a.sortAt - b.sortAt)

  // Oldest first to accumulate, then handed back newest first — which is the
  // order a person reads a statement in.
  let running = 0
  const withBalance = merged.map((row) => {
    running += row.amount
    return { ...row, balanceAfter: running }
  })

  const limited = params.limit ? withBalance.slice(-params.limit) : withBalance
  return limited.reverse().map(({ sortAt: _sortAt, ...row }) => row)
}
