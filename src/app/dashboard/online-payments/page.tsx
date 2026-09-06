import type { Metadata } from 'next'
import Link from 'next/link'
import { Landmark } from 'lucide-react'

import { AutoRefresh } from '@/components/auto-refresh'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getOnlinePayments } from '@/features/payments/queries'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Online payments' }

export default async function OnlinePaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PAYMENT_COLLECT, '/dashboard/online-payments')
  const { branchIds } = await selectedBranch(user, await searchParams)
  const [restaurant, rows] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getOnlinePayments(user.restaurantId, branchIds),
  ])

  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const money = (v: number) => formatMoney(v, restaurant.currency, locale)

  const pending = rows.filter((r) => r.orderPaymentStatus !== 'PAID')
  const confirmedToday = rows.filter((r) => r.status === 'PAID')
  const confirmedTotal = confirmedToday.reduce((sum, r) => sum + r.amount, 0)

  return (
    <>
      <AutoRefresh intervalMs={8000} />
      <PageHeader
        title="Online payments"
        description="Bank transfers and online payments your guests declared — cross-check them against your account and confirm."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Awaiting confirmation" value={pending.length} />
        <StatCard label="Confirmed payments" value={confirmedToday.length} />
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
                      <td className="py-2.5 pr-3 text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString(locale, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </td>
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
