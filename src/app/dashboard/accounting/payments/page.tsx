import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PaymentConsole } from '@/features/outgoing-payments/components/payment-console'
import { ensureDefaultCategories } from '@/features/outgoing-payments/service'
import { listExpenseCategories, listOutgoingPayments } from '@/features/outgoing-payments/queries'
import { can, PERMISSIONS } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Payments out' }

/**
 * The accountant's worklist: money leaving the business, from draft to paid.
 * Recording is this desk's job; approving is deliberately the owner's.
 */
export default async function PaymentsOutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/accounting/payments')
  const restaurant = await requireRestaurant(user.restaurantId)
  const selection = await selectedBranch(user, await searchParams)

  await ensureDefaultCategories(user.restaurantId)

  const [rows, suppliers, categories, branches] = await Promise.all([
    listOutgoingPayments({ restaurantId: user.restaurantId, branchIds: selection.branchIds }),
    prisma.supplier.findMany({
      where: { restaurantId: user.restaurantId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    listExpenseCategories(user.restaurantId).then((all) => all.filter((c) => c.isActive)),
    prisma.branch.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        isActive: true,
        ...(selection.branchIds ? { id: { in: selection.branchIds } } : {}),
      },
      select: { id: true, name: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
  ])

  return (
    <>
      <PageHeader
        title="Payments out"
        description="Draft it, submit it for the owner's sign-off, then pay it. A paid payment is immutable — corrections reverse."
      />
      <PaymentConsole
        rows={rows}
        suppliers={suppliers}
        categories={categories}
        branches={branches}
        defaultBranchId={selection.branchId ?? user.branchId ?? null}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
        canCreate={can(user, PERMISSIONS.ACCOUNTING_PAYMENT_CREATE)}
        canPay={can(user, PERMISSIONS.ACCOUNTING_PAYMENT_PAY)}
      />
    </>
  )
}
