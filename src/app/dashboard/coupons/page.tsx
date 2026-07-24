import type { Metadata } from 'next'

import { CouponsManager } from '@/features/staff/components/coupons-manager'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Coupons' }

export default async function CouponsPage() {
  const user = await requirePagePermission(PERMISSIONS.COUPON_MANAGE, '/dashboard/coupons')
  const [restaurant, coupons] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.coupon.findMany({
      where: { restaurantId: user.restaurantId },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return (
    <CouponsManager
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      coupons={coupons.map((coupon) => ({
        id: coupon.id,
        code: coupon.code,
        description: coupon.description,
        type: coupon.type,
        value: coupon.value,
        minOrderAmount: coupon.minOrderAmount,
        maxDiscount: coupon.maxDiscount,
        usageLimit: coupon.usageLimit,
        usedCount: coupon.usedCount,
        isActive: coupon.isActive,
        startsAt: coupon.startsAt?.toISOString() ?? null,
        endsAt: coupon.endsAt?.toISOString() ?? null,
      }))}
    />
  )
}
