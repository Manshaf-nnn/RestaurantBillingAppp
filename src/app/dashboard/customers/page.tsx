import type { Metadata } from 'next'

import { CustomersManager } from '@/features/staff/components/customers-manager'
import { can, PERMISSIONS , customersAtBranch, visibleBranchIds} from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Customers' }

export default async function CustomersPage() {
  const user = await requirePagePermission(PERMISSIONS.CUSTOMER_VIEW, '/dashboard/customers')
  const [restaurant, customers] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.customer.findMany({
      // Each branch sees the people who have ordered there. See
      // `customersAtBranch` for why the RECORD stays whole.
      where: { restaurantId: user.restaurantId, ...customersAtBranch(visibleBranchIds(user)) },
      orderBy: [{ lastOrderAt: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    }),
  ])

  return (
    <CustomersManager
      canManage={can(user, PERMISSIONS.CUSTOMER_MANAGE)}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
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
