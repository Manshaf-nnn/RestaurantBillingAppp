import type { Metadata } from 'next'
import Link from 'next/link'
import { Landmark } from 'lucide-react'

import { AutoRefresh } from '@/components/auto-refresh'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getDestinationTotals, getOnlinePayments } from '@/features/payments/queries'
import { readPaymentConfig } from '@/features/payments/service'
import { destinationDetailLine } from '@/features/payments/destinations'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { formatDateTime } from '@/lib/datetime'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Payment details' }

/**
 * Where the money went, account by account.
 *
 * ── Two things on one page, and why ─────────────────────────────────────────
 *
 * The top half answers "how much has landed in BOC?" — every account the owner
 * defined in Settings, with what has been filed under it. The bottom half is
 * the bank-transfer confirmation list this page has always been: guests declare
 * a transfer, somebody checks the real account and confirms. They belong
 * together because they are the same question at two zoom levels — the totals
 * are what the transfers add up to.
 *
 * ── Why the accounts are gated tighter than the page ────────────────────────
 *
 * The page answers to PAYMENT_COLLECT, which a cashier holds, because
 * confirming transfers is a till job. Account numbers and holder names are not
 * a till's business, so the accounts block asks for SETTINGS_VIEW — the same
 * permission that lets somebody see where these were defined in the first
 * place.
 */
export default async function PaymentDetailsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PAYMENT_COLLECT, '/dashboard/payment-details')
  const { branchIds } = await selectedBranch(user, await searchParams)
  const seesAccounts = can(user, PERMISSIONS.SETTINGS_VIEW)

  const [restaurant, rows, totals] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getOnlinePayments(user.restaurantId, branchIds),
    seesAccounts ? getDestinationTotals(user.restaurantId, branchIds) : Promise.resolve([]),
  ])

  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const money = (v: number) => formatMoney(v, restaurant.currency, locale)
  const when = (value: string | null) =>
    value ? formatDateTime(value, { locale, timeZone: restaurant.timezone }) : '—'

  const config = readPaymentConfig(restaurant.paymentConfig)

  /*
   * Every account the owner defined, plus any code that money is already filed
   * under. The second half matters: an account retired last month still holds
   * last month's takings, and dropping it here would make that money vanish
   * from the only screen that adds it up.
   */
  const banked = totals.map((row) => row.destination)
  const accounts = [
    ...(config.destinations ?? []).filter((destination) => !destination.archived),
    ...(config.destinations ?? []).filter(
      (destination) => destination.archived && banked.includes(destination.code),
    ),
  ]

  const cards = accounts.map((destination) => {
    const found = totals.find((row) => row.destination === destination.code)
    return {
      code: destination.code,
      name: destination.name,
      detail: destinationDetailLine(destination),
      archived: Boolean(destination.archived),
      collected: found?.collected ?? 0,
      refunded: found?.refunded ?? 0,
      count: found?.count ?? 0,
      lastAt: found?.lastAt ?? null,
    }
  })

  // Money taken before any of this existed. Shown only when it exists, because
  // an "Unassigned" tile on a clean restaurant is a question with no answer.
  const unassigned = totals.find((row) => row.destination === null)

  const pending = rows.filter((r) => r.orderPaymentStatus !== 'PAID')
  const confirmed = rows.filter((r) => r.status === 'PAID')
  const confirmedTotal = confirmed.reduce((sum, r) => sum + r.amount, 0)

  return (
    <>
      <AutoRefresh intervalMs={8000} />
      <PageHeader
        title="Payment details"
        description="Every account your money is filed under, and the bank transfers waiting to be confirmed."
      />

      {seesAccounts ? (
        <div className="mb-4">
          <SectionCard
            title="Your accounts"
            description="Set up under Settings → Payments. A cashier taking cash files it here automatically — open one to see every payment inside it."
          >
            {cards.length === 0 && !unassigned ? (
              <EmptyState
                className="border-dashed py-10"
                icon={<Landmark />}
                title="No accounts yet"
                description="Add one under Settings → Payments and point each payment method at it."
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {cards.map((card) => (
                  <Link
                    key={card.code}
                    href={`/dashboard/payment-details/${card.code}`}
                    className="rounded-lg border p-4 transition-colors hover:border-primary/60 hover:bg-muted/40"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold">{card.name}</span>
                      {card.archived ? <Badge variant="outline">Retired</Badge> : null}
                    </div>
                    {card.detail ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{card.detail}</p>
                    ) : null}

                    <p className="mt-3 text-xl font-bold tabular-nums">
                      {money(card.collected - card.refunded)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {card.count} payment{card.count === 1 ? '' : 's'}
                      {card.refunded > 0 ? ` · ${money(card.refunded)} refunded` : ''}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Last: {when(card.lastAt)}
                    </p>
                  </Link>
                ))}

                {unassigned ? (
                  <Link
                    href="/dashboard/payment-details/unassigned"
                    className="rounded-lg border border-dashed p-4 transition-colors hover:border-primary/60 hover:bg-muted/40"
                  >
                    <span className="font-semibold">Unassigned</span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Taken before accounts were set up
                    </p>
                    <p className="mt-3 text-xl font-bold tabular-nums">
                      {money(unassigned.collected - unassigned.refunded)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {unassigned.count} payment{unassigned.count === 1 ? '' : 's'}
                    </p>
                  </Link>
                ) : null}
              </div>
            )}
          </SectionCard>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Awaiting confirmation" value={pending.length} />
        <StatCard label="Confirmed payments" value={confirmed.length} />
        <StatCard label="Confirmed value" value={money(confirmedTotal)} />
      </div>

      <div className="mt-4">
        <SectionCard title="Recent online transfers">
          {rows.length === 0 ? (
            <EmptyState
              className="border-dashed py-10"
              icon={<Landmark />}
              title="No online payments yet"
              description="When guests pay by bank transfer, they'll appear here so you can verify each one."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-semibold">Order</th>
                    <th className="py-2 pr-3 font-semibold">Table</th>
                    <th className="py-2 pr-3 font-semibold">Guest</th>
                    <th className="py-2 pr-3 font-semibold">When</th>
                    <th className="py-2 pr-3 text-right font-semibold">Amount</th>
                    <th className="py-2 pl-3 text-right font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => (
                    <tr key={r.id} className="align-middle">
                      <td className="py-2.5 pr-3 font-medium">
                        <Link href={`/dashboard/orders/${r.orderId}`} className="hover:text-primary hover:underline">
                          #{r.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{r.tableNumber ?? '—'}</td>
                      <td className="py-2.5 pr-3">{r.customerName}</td>
                      {/* The restaurant's clock, not the server's — a transfer
                          stamped five and a half hours out is unmatchable. */}
                      <td className="py-2.5 pr-3 text-muted-foreground">{when(r.createdAt)}</td>
                      <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{money(r.amount)}</td>
                      <td className="py-2.5 pl-3 text-right">
                        {r.orderPaymentStatus === 'PAID' ? (
                          <Badge variant="success">Confirmed</Badge>
                        ) : (
                          <Badge variant="warning">Awaiting confirmation</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pending.length > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Tip: confirm a payment from the{' '}
              <Link href="/cashier" className="font-medium text-primary hover:underline">
                Cashier
              </Link>{' '}
              screen once the transfer lands in your account.
            </p>
          ) : null}
        </SectionCard>
      </div>
    </>
  )
}
