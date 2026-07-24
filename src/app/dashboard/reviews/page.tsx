import type { Metadata } from 'next'

import { ReviewsManager } from '@/features/staff/components/reviews-manager'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Reviews' }

export default async function ReviewsPage() {
  const user = await requirePagePermission(PERMISSIONS.REVIEW_MANAGE, '/dashboard/reviews')
  const [restaurant, reviews, agg] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.review.findMany({
      where: { restaurantId: user.restaurantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { customer: { select: { name: true } }, order: { select: { orderNumber: true } } },
    }),
    prisma.review.aggregate({ where: { restaurantId: user.restaurantId }, _avg: { rating: true } }),
  ])

  return (
    <ReviewsManager
      average={agg._avg.rating ?? 0}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      reviews={reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        foodRating: review.foodRating,
        serviceRating: review.serviceRating,
        comment: review.comment,
        reply: review.reply,
        customerName: review.customer?.name ?? 'Guest',
        orderNumber: review.order.orderNumber,
        isPublished: review.isPublished,
        createdAt: review.createdAt.toISOString(),
      }))}
    />
  )
}
