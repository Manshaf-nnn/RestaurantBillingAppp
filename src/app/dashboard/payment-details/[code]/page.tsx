import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { readPaymentConfig, METHOD_LABELS } from '@/features/payments/service'
import { accountTransactions } from '@/features/payments/accounts-queries'
import { assertCanUseAccount } from '@/features/payments/accounts'
import { accountBalances } from '@/features/payments/accounts-ledger'
import { prisma } from '@/server/db/prisma'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { formatDateTime } from '@/lib/datetime'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Account' }

/** The URL for money taken before destinations existed. */
const UNASSIGNED = 'unassigned'

/**
 * Every payment filed under one account.
 *
 * ── Two guards, because two different questions are being asked ─────────────
 *
 * The first is PAYMENT_VIEW, a permission this page's own feature owns. That is
 * what makes switching "Payments & till" off actually refuse this URL, instead
 * of merely hiding a menu entry — and a static check enforces that every page
 * names one of its feature's own permissions.
 *
 * The second is SETTINGS_VIEW, and it is the one that matters here. PAYMENT_VIEW
 * is a cashier's permission; account numbers and holder names are not a till's
 * business. So the feature switch decides whether this page EXISTS, and
 * SETTINGS_VIEW — the same permission that governs where these accounts were
 * defined — decides who may read it.
 *
 * ── The account is resolved from settings, not from the URL ─────────────────
 *
 * A code that no account claims 404s rather than rendering an empty page
 * titled with whatever was typed into the address bar — otherwise the URL is
 * an invitation to enumerate a tenant's account codes and get a page back for
 * each guess. `unassigned` is the one exception, and it is a real query.
 */
export default async function PaymentAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { code } = await params
  const user = await requirePagePermission(
    PERMISSIONS.ACCOUNT_VIEW,
    `/dashboard/payment-details/${code}`,
  )
  /*
   * Read for the header only. The account switcher is not what narrows this
   * page: a balance and its history are facts about the account, not about a
   * location, so both are restaurant-wide. Called because every dashboard page
   * resolves a branch, and because the branch cookie is what the rest of the
   * shell reads.
   */
  await selectedBranch(user, await searchParams)
  const restaurant = await requireRestaurant(user.restaurantId)
  const config = readPaymentConfig(restaurant.paymentConfig)

  const account =
    code === UNASSIGNED
      ? null
      : await prisma.paymentAccount.findFirst({
          where: { restaurantId: user.restaurantId, code },
        })
  if (!account && code !== UNASSIGNED) notFound()

  /*
   * Whose account this is (bank.md §2), checked on the server.
   *
   * `ACCOUNT_VIEW` opens the screen; this decides whether THIS account is one
   * of theirs. A code typed into the address bar by somebody it was never
   * assigned to is refused here, not merely hidden on the card list.
   */
  if (account) {
    await assertCanUseAccount({ user, accountId: account.id, need: 'view' })
  }

  const [rows, balances] = await Promise.all([
    accountTransactions({ restaurantId: user.restaurantId, code, limit: 200 }),
    accountBalances(prisma, user.restaurantId),
  ])

  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const money = (v: number) => formatMoney(v, restaurant.currency, locale)

  const balance = balances.find((row) => row.code === code)?.balance ?? 0
  const collected = rows.filter((row) => row.amount > 0).reduce((sum, row) => sum + row.amount, 0)
  const refunded = rows.filter((row) => row.amount < 0).reduce((sum, row) => sum - row.amount, 0)

  // Which methods currently point here — "this is where card money goes".
  const feeders = Object.entries(config.methodDestinations ?? {})
    .filter(([, pointsAt]) => pointsAt === code)
    .map(([method]) => METHOD_LABELS[method] ?? method)

  const detail = account
    ? [account.bankName, account.accountNumber ? `A/C ${account.accountNumber}` : null, account.holderName]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <>
      <PageHeader
        title={account?.name ?? 'Unassigned'}
        description={
          account
            ? detail || 'No bank details recorded — add them under Settings → Payments.'
            : 'Money taken before payment accounts were set up. Nothing is wrong with it; it simply predates the setting.'
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link
          href="/dashboard/payment-details"
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          ← All accounts
        </Link>
        {account && !account.isActive ? <Badge variant="outline">Retired</Badge> : null}
        {feeders.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            Fed by {feeders.join(', ')}
          </span>
        ) : account?.isActive ? (
          <span className="text-xs text-muted-foreground">
            No payment method points here yet
          </span>
        ) : null}
      </div>

      {/*
        The balance first, because it is the question. The two beside it are
        what it is made of, so the number can be explained rather than trusted.
      */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Balance" value={money(balance)} />
        <StatCard label="In" value={money(collected)} />
        <StatCard label="Out" value={money(refunded)} />
      </div>

      <div className="mt-4">
        <SectionCard
          title={`Transactions (${rows.length})`}
          description="Every movement, newest first — deposits, transfers, and the payments filed here automatically."
        >
          {rows.length === 0 ? (
            <EmptyState
              className="border-dashed py-10"
              title="Nothing here yet"
              description="Deposits, transfers and settled payments all appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-semibold">When</th>
                    <th className="py-2 pr-3 font-semibold">Type</th>
                    <th className="py-2 pr-3 font-semibold">From / to</th>
                    <th className="py-2 pr-3 font-semibold">Reason</th>
                    <th className="py-2 pr-3 font-semibold">Staff</th>
                    <th className="py-2 pr-3 text-right font-semibold">Amount</th>
                    <th className="py-2 pl-3 text-right font-semibold">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <tr key={row.id} className="align-middle">
                      <td className="py-2.5 pr-3 text-muted-foreground">
                        {formatDateTime(row.at, { locale, timeZone: restaurant.timezone })}
                      </td>
                      <td className="py-2.5 pr-3 font-medium">{row.type}</td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{row.counterparty ?? '—'}</td>
                      <td className="py-2.5 pr-3 text-muted-foreground">
                        {row.reason ? (METHOD_LABELS[row.reason] ?? row.reason) : '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{row.actorName ?? '—'}</td>
                      {/*
                        Signed, so money in and money out are told apart at a
                        glance rather than by reading the type column.
                      */}
                      <td
                        className={`py-2.5 pr-3 text-right font-semibold tabular-nums ${
                          row.amount < 0 ? 'text-destructive' : 'text-success'
                        }`}
                      >
                        {row.amount < 0 ? '−' : '+'} {money(Math.abs(row.amount))}
                      </td>
                      <td className="py-2.5 pl-3 text-right tabular-nums">{money(row.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows.length >= 200 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing the most recent 200. Use Reports for a full period.
            </p>
          ) : null}
        </SectionCard>
      </div>
    </>
  )
}
