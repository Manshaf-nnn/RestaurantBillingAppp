import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getDestinationPayments } from '@/features/payments/queries'
import { readPaymentConfig, METHOD_LABELS } from '@/features/payments/service'
import { destinationDetailLine } from '@/features/payments/destinations'
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
    PERMISSIONS.PAYMENT_VIEW,
    `/dashboard/payment-details/${code}`,
  )
  if (!can(user, PERMISSIONS.SETTINGS_VIEW)) redirect('/forbidden')
  const { branchIds } = await selectedBranch(user, await searchParams)
  const restaurant = await requireRestaurant(user.restaurantId)

  const config = readPaymentConfig(restaurant.paymentConfig)
  const account = (config.destinations ?? []).find((entry) => entry.code === code) ?? null
  if (!account && code !== UNASSIGNED) notFound()

  const rows = await getDestinationPayments(
    user.restaurantId,
    code === UNASSIGNED ? null : code,
    branchIds,
  )

  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const money = (v: number) => formatMoney(v, restaurant.currency, locale)

  const collected = rows.reduce((sum, row) => sum + row.amount, 0)
  const refunded = rows.reduce((sum, row) => sum + row.refunded, 0)

  // Which methods currently point here — "this is where card money goes".
  const feeders = Object.entries(config.methodDestinations ?? {})
    .filter(([, pointsAt]) => pointsAt === code)
    .map(([method]) => METHOD_LABELS[method] ?? method)

  const detail = account ? destinationDetailLine(account) : ''

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
        {account?.archived ? <Badge variant="outline">Retired</Badge> : null}
        {feeders.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            Fed by {feeders.join(', ')}
          </span>
        ) : account && !account.archived ? (
          <span className="text-xs text-muted-foreground">
            No payment method points here yet
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Collected" value={money(collected)} />
        <StatCard label="Refunded" value={money(refunded)} />
        <StatCard label="Net" value={money(collected - refunded)} />
      </div>

      <div className="mt-4">
        <SectionCard
          title={`Payments filed here (${rows.length})`}
          description="Newest first. Every one of these was recorded the moment a cashier settled the bill."
        >
          {rows.length === 0 ? (
            <EmptyState
              className="border-dashed py-10"
              title="Nothing filed here yet"
              description="Payments appear the moment a cashier settles a bill on a method pointing at this account."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-semibold">When</th>
                    <th className="py-2 pr-3 font-semibold">Order</th>
                    <th className="py-2 pr-3 font-semibold">Invoice</th>
                    <th className="py-2 pr-3 font-semibold">Branch</th>
                    <th className="py-2 pr-3 font-semibold">Method</th>
                    <th className="py-2 pr-3 text-right font-semibold">Amount</th>
                    <th className="py-2 pl-3 text-right font-semibold">Refunded</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <tr key={row.id} className="align-middle">
                      <td className="py-2.5 pr-3 text-muted-foreground">
                        {row.paidAt
                          ? formatDateTime(row.paidAt, { locale, timeZone: restaurant.timezone })
                          : '—'}
                      </td>
                      <td className="py-2.5 pr-3 font-medium">
                        <Link
                          href={`/dashboard/orders/${row.orderId}`}
                          className="hover:text-primary hover:underline"
                        >
                          #{row.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">
                        {row.invoiceNumber ?? '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{row.branchName ?? '—'}</td>
                      <td className="py-2.5 pr-3">{METHOD_LABELS[row.method] ?? row.method}</td>
                      <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">
                        {money(row.amount)}
                      </td>
                      <td className="py-2.5 pl-3 text-right tabular-nums text-muted-foreground">
                        {row.refunded > 0 ? `− ${money(row.refunded)}` : '—'}
                      </td>
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
