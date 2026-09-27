import 'server-only'

import type { PaymentMethod } from '@prisma/client'

import type { TenantUser } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

import { unconfined, visibleAccountsFor } from './accounts'

/**
 * The Payment details report: where the money came in, by which method, into
 * which account, and what was moved between accounts.
 *
 * ── It adds up the same way the accounts do ─────────────────────────────────
 *
 * An account's balance is derived, never stored (`accounts-ledger.ts`):
 * payments stamped with its code, less refunds stamped with it, plus deposits
 * and transfers. This report reads exactly those rows over a period, so the
 * figures here and the balances on Payment details can never disagree.
 * PAID and REFUNDED payments both count as collected and refunds are then
 * subtracted — the basis `accountBalances` uses.
 *
 * ── It shows only the accounts this person may see ──────────────────────────
 *
 * Which accounts a person sees is the owner's decision (`whyCannotUseAccount`).
 * A report that summed every account regardless would hand anyone with the
 * page the very figures the owner withheld. So payments are narrowed to the
 * codes of this person's accounts; the owner and administrators see all,
 * including payments that were never filed under any account ("Unassigned").
 *
 * ── Branch, and what it applies to ──────────────────────────────────────────
 *
 * Payments and refunds belong to an order, and an order to a branch, so the
 * branch filter narrows them. Deposits, transfers and balances belong to a
 * bank account, which is not at any branch — they are always all-locations,
 * and the screen says so.
 */

export const UNASSIGNED = '__unassigned__'

export interface PaymentReportData {
  collected: number
  refunded: number
  net: number
  /** Net against the same-length period just before; null when that was zero. */
  netChange: number | null
  payments: number
  refunds: number
  averagePayment: number
  moved: { value: number; count: number }
  deposited: { value: number; count: number }
  /** Sum of the balances of every account this person sees, all-time. */
  totalBalance: number
  accountCount: number
  /** One point per day in the restaurant's timezone: net collected that day. */
  trend: Array<{ date: string; collected: number; refunded: number; net: number }>
  byAccount: Array<{ code: string; name: string; collected: number; refunded: number; net: number; share: number }>
  byMethod: Array<{ method: PaymentMethod; count: number; collected: number; refunded: number; net: number }>
  balances: Array<{ code: string; name: string; balance: number; netInPeriod: number }>
  movements: Array<{
    id: string
    at: string
    kind: 'Deposit' | 'Transfer'
    account: string
    counterparty: string | null
    amount: number
    reason: string | null
    actorName: string | null
  }>
}

function dayKey(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, in whatever zone it is told.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** Every calendar day in [from, to], in the restaurant's timezone, so a quiet day plots as zero. */
function daysBetween(from: Date, to: Date, timeZone: string): string[] {
  const days: string[] = []
  const seen = new Set<string>()
  // Step in 6-hour hops so no zone offset or DST change can skip a day.
  for (let t = from.getTime(); t <= to.getTime(); t += 6 * 3_600_000) {
    const key = dayKey(new Date(t), timeZone)
    if (!seen.has(key)) {
      seen.add(key)
      days.push(key)
    }
  }
  const last = dayKey(to, timeZone)
  if (!seen.has(last)) days.push(last)
  return days
}

export async function getPaymentReport(params: {
  user: TenantUser
  /** One branch, or null for every branch this person may see. */
  branchIds: string[] | null
  from: Date
  to: Date
  previous: { from: Date; to: Date }
  timeZone: string
}): Promise<PaymentReportData> {
  const { user, from, to, timeZone } = params
  const restaurantId = user.restaurantId

  const accounts = await visibleAccountsFor(user)
  const everything = unconfined(user)
  const codes = accounts.map((account) => account.code)
  const nameOf = new Map(accounts.map((account) => [account.code, account.name]))

  /*
   * Which payments this person may see: the owner and administrators, all of
   * them; anyone else, only those filed under an account they were given.
   * An empty list is a real answer ("none") and must not become "no filter".
   */
  const destinationScope = everything ? {} : { destination: { in: codes.length ? codes : ['__none__'] } }
  const branchScope = params.branchIds ? { order: { branchId: { in: params.branchIds } } } : {}

  const paidWhen = (window: { from: Date; to: Date }) => ({
    OR: [
      { paidAt: { gte: window.from, lte: window.to } },
      // A payment written before `paidAt` existed carries only its creation time.
      { paidAt: null, createdAt: { gte: window.from, lte: window.to } },
    ],
  })

  const accountIds = accounts.map((account) => account.accountId)

  const [payments, refunds, previousPaid, previousRefunded, entries] = await Promise.all([
    prisma.payment.findMany({
      where: { restaurantId, status: { in: ['PAID', 'REFUNDED'] }, ...destinationScope, ...branchScope, ...paidWhen({ from, to }) },
      select: { amount: true, method: true, destination: true, paidAt: true, createdAt: true },
    }),
    prisma.refund.findMany({
      where: { restaurantId, ...destinationScope, ...branchScope, createdAt: { gte: from, lte: to } },
      select: { amount: true, method: true, destination: true, createdAt: true },
    }),
    prisma.payment.aggregate({
      where: { restaurantId, status: { in: ['PAID', 'REFUNDED'] }, ...destinationScope, ...branchScope, ...paidWhen(params.previous) },
      _sum: { amount: true },
    }),
    prisma.refund.aggregate({
      where: { restaurantId, ...destinationScope, ...branchScope, createdAt: { gte: params.previous.from, lte: params.previous.to } },
      _sum: { amount: true },
    }),
    prisma.paymentAccountEntry.findMany({
      where: {
        restaurantId,
        accountId: { in: accountIds.length ? accountIds : ['__none__'] },
        createdAt: { gte: from, lte: to },
        // A transfer is shown once, from the side the money left.
        type: { in: ['DEPOSIT', 'TRANSFER_OUT'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, type: true, amount: true, reason: true, actorName: true, createdAt: true,
        account: { select: { name: true } },
        counterpartyAccount: { select: { name: true } },
      },
    }),
  ])

  const collected = payments.reduce((sum, row) => sum + row.amount, 0)
  const refunded = refunds.reduce((sum, row) => sum + row.amount, 0)
  const net = collected - refunded
  const previousNet = (previousPaid._sum.amount ?? 0) - (previousRefunded._sum.amount ?? 0)

  // ── Trend ────────────────────────────────────────────────────────────────
  const perDay = new Map<string, { collected: number; refunded: number }>()
  for (const day of daysBetween(from, to, timeZone)) perDay.set(day, { collected: 0, refunded: 0 })
  for (const row of payments) {
    const key = dayKey(row.paidAt ?? row.createdAt, timeZone)
    const bucket = perDay.get(key) ?? { collected: 0, refunded: 0 }
    bucket.collected += row.amount
    perDay.set(key, bucket)
  }
  for (const row of refunds) {
    const key = dayKey(row.createdAt, timeZone)
    const bucket = perDay.get(key) ?? { collected: 0, refunded: 0 }
    bucket.refunded += row.amount
    perDay.set(key, bucket)
  }
  const trend = [...perDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, collected: v.collected, refunded: v.refunded, net: v.collected - v.refunded }))

  // ── By account ───────────────────────────────────────────────────────────
  const accountTotals = new Map<string, { collected: number; refunded: number }>()
  const bump = (code: string | null, field: 'collected' | 'refunded', amount: number) => {
    const key = code ?? UNASSIGNED
    const row = accountTotals.get(key) ?? { collected: 0, refunded: 0 }
    row[field] += amount
    accountTotals.set(key, row)
  }
  for (const row of payments) bump(row.destination, 'collected', row.amount)
  for (const row of refunds) bump(row.destination, 'refunded', row.amount)
  const positiveNet = [...accountTotals.values()].reduce((sum, row) => sum + Math.max(0, row.collected - row.refunded), 0)
  const byAccount = [...accountTotals.entries()]
    .map(([code, row]) => {
      const accountNet = row.collected - row.refunded
      return {
        code,
        name: code === UNASSIGNED ? 'Unassigned' : (nameOf.get(code) ?? code),
        collected: row.collected,
        refunded: row.refunded,
        net: accountNet,
        share: positiveNet > 0 ? Math.max(0, accountNet) / positiveNet : 0,
      }
    })
    .sort((a, b) => b.net - a.net)

  // ── By method ────────────────────────────────────────────────────────────
  const methodTotals = new Map<PaymentMethod, { count: number; collected: number; refunded: number }>()
  for (const row of payments) {
    const m = methodTotals.get(row.method) ?? { count: 0, collected: 0, refunded: 0 }
    m.count += 1
    m.collected += row.amount
    methodTotals.set(row.method, m)
  }
  for (const row of refunds) {
    const m = methodTotals.get(row.method) ?? { count: 0, collected: 0, refunded: 0 }
    m.refunded += row.amount
    methodTotals.set(row.method, m)
  }
  const byMethod = [...methodTotals.entries()]
    .map(([method, m]) => ({ method, ...m, net: m.collected - m.refunded }))
    .sort((a, b) => b.net - a.net)

  // ── Balances, and what the period did to each ────────────────────────────
  const balances = accounts
    .map((account) => ({
      code: account.code,
      name: account.name,
      balance: account.balance,
      netInPeriod: (accountTotals.get(account.code)?.collected ?? 0) - (accountTotals.get(account.code)?.refunded ?? 0),
    }))
    .sort((a, b) => b.balance - a.balance)

  // ── Movements between and into accounts ──────────────────────────────────
  const deposits = entries.filter((entry) => entry.type === 'DEPOSIT')
  const transfers = entries.filter((entry) => entry.type === 'TRANSFER_OUT')

  return {
    collected,
    refunded,
    net,
    netChange: previousNet !== 0 ? (net - previousNet) / Math.abs(previousNet) : null,
    payments: payments.length,
    refunds: refunds.length,
    averagePayment: payments.length ? Math.round(collected / payments.length) : 0,
    moved: { value: transfers.reduce((sum, row) => sum + row.amount, 0), count: transfers.length },
    deposited: { value: deposits.reduce((sum, row) => sum + row.amount, 0), count: deposits.length },
    totalBalance: accounts.reduce((sum, account) => sum + account.balance, 0),
    accountCount: accounts.length,
    trend,
    byAccount,
    byMethod,
    balances,
    movements: entries.slice(0, 50).map((entry) => ({
      id: entry.id,
      at: entry.createdAt.toISOString(),
      kind: entry.type === 'DEPOSIT' ? ('Deposit' as const) : ('Transfer' as const),
      account: entry.account.name,
      counterparty: entry.counterpartyAccount?.name ?? null,
      amount: entry.amount,
      reason: entry.reason,
      actorName: entry.actorName,
    })),
  }
}
