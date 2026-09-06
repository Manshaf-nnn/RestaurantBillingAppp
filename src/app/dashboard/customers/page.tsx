import type { Metadata } from 'next'

import { CustomersManager } from '@/features/staff/components/customers-manager'
import { can, PERMISSIONS, customersAtBranch } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Customers' }

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.CUSTOMER_VIEW, '/dashboard/customers')

  /*
   * `selectedBranch`, not `visibleBranchIds` alone.
   *
   * This read the RBAC reach directly, so for an owner it was always `null` and
   * the branch switcher had no effect on this page whatsoever — pick Kandy and
   * the customer list did not move. `selectedBranch` folds the chosen branch
   * into the same reach every other screen uses, and cannot widen it: an
   * out-of-reach id degrades to the reach rather than overriding it.
   */
  const selection = await selectedBranch(user, await searchParams)

  const [restaurant, customers] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.customer.findMany({
      // Each branch sees the people who have ordered there. See
      // `customersAtBranch` for why the RECORD stays whole.
      where: { restaurantId: user.restaurantId, ...customersAtBranch(selection.branchIds) },
      orderBy: [{ lastOrderAt: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    }),
  ])

  return (
    <CustomersManager
      canManage={can(user, PERMISSIONS.CUSTOMER_MANAGE)}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
      customers={customers.map((customer) => ({
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        notes: customer.notes,
        loyaltyPoints: customer.loyaltyPoints,
        totalSpent: customer.totalSpent,
        totalOrders: customer.totalOrders,
        lastOrderAt: customer.lastOrderAt?.toISOString() ?? null,
        isBlocked: customer.isBlocked,
      }))}
    />
  )
}
