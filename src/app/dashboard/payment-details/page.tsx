import type { Metadata } from 'next'
import Link from 'next/link'
import { Landmark } from 'lucide-react'

import { AutoRefresh } from '@/components/auto-refresh'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getOnlinePayments } from '@/features/payments/queries'
import { AccountsPanel } from '@/features/payments/components/accounts-panel'
import { accountStaffOptions, accountsForScreen } from '@/features/payments/accounts-queries'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { formatDateTime } from '@/lib/datetime'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { resolveRange } from '@/features/reports/range'
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
  /*
   * ACCOUNT_VIEW, not PAYMENT_COLLECT (bank.md).
   *
   * The door moved with the feature, and `ACCOUNT_VIEW` is split from
   * `PAYMENT_COLLECT` so nobody who could open this yesterday is locked out
   * today — a cashier still reaches the transfer-confirmation list below.
   * Which ACCOUNTS they see is a separate, per-account question.
   */
  const user = await requirePagePermission(PERMISSIONS.ACCOUNT_VIEW, '/dashboard/payment-details')
  const { branchIds } = await selectedBranch(user, await searchParams)

  const restaurant = await requireRestaurant(user.restaurantId)
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const money = (v: number) => formatMoney(v, restaurant.currency, locale)
  const when = (value: string | null) =>
    value ? formatDateTime(value, { locale, timeZone: restaurant.timezone }) : '—'

  /*
   * The accounts are NOT branch-filtered, and the transfers below are.
   *
   * A balance is a fact about a bank account, not about a location: BOC holds
   * what BOC holds, and narrowing it by the branch switcher would show a
   * contribution under a label that says Balance — a number that could never
   * match the real account. The confirmation list underneath is genuinely
   * per-branch, so it keeps the filter.
   */
  const canManage = can(user, PERMISSIONS.ACCOUNT_MANAGE)
  const [rows, accounts, people] = await Promise.all([
    getOnlinePayments(user.restaurantId, branchIds),
    accountsForScreen(user),
    canManage ? accountStaffOptions(user) : Promise.resolve({ staff: [], access: [] }),
  ])

  const pending = rows.filter((r) => r.orderPaymentStatus !== 'PAID')
  const confirmed = rows.filter((r) => r.status === 'PAID')
  const confirmedTotal = confirmed.reduce((sum, r) => sum + r.amount, 0)

  return (
    <>
      <AutoRefresh intervalMs={30000} />
      <PageHeader
        title="Payment details"
        description="Every account your money is filed under, and the bank transfers waiting to be confirmed."
      />

      <div className="mb-4">
        <AccountsPanel
          accounts={accounts}
          staff={people.staff}
          access={people.access}
          currency={restaurant.currency}
          locale={locale}
          canManage={canManage}
          basePath="/dashboard/payment-details"
        />
      </div>

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
              <Link href="/cashier/pos?tab=cashier" className="font-medium text-primary hover:underline">
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
