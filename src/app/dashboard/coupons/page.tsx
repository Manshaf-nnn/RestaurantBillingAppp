import type { Metadata } from 'next'

import { CouponsManager } from '@/features/staff/components/coupons-manager'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Coupons' }

export default async function CouponsPage() {
  const user = await requirePagePermission(PERMISSIONS.COUPON_MANAGE, '/dashboard/coupons')
  const reach = visibleBranchIds({ role: user.role, branchId: user.branchId })

  const [restaurant, coupons, locations] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.coupon.findMany({
      where: {
        restaurantId: user.restaurantId,
        /*
         * A group-wide code — `branchId: null` — belongs to everybody and stays
         * visible. What narrows is a code pinned to somewhere this person
         * cannot see.
         */
        ...(reach ? { OR: [{ branchId: null }, { branchId: { in: reach } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { name: true } } },
    }),
    listSwitchableLocations(user.restaurantId, reach),
  ])

  return (
    <CouponsManager
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
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
        branchId: coupon.branchId,
        branchName: coupon.branch?.name ?? null,
      }))}
    />
  )
}
