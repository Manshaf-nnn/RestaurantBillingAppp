import type { Metadata } from 'next'

import { ReviewsManager } from '@/features/staff/components/reviews-manager'
import { PERMISSIONS } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Reviews' }

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REVIEW_MANAGE, '/dashboard/reviews')

  /*
   * A review is about one meal at one place.
   *
   * `Review` has no `branchId` and does not need one: `orderId` is required and
   * unique, so the branch is exactly one hop away — the same rule `Payment` and
   * `ServiceRequest` already use, and the reason neither of those carries a
   * copy either. Duplicating it would be a second answer to a question the
   * order already answers.
   *
   * Before this the page filtered on the restaurant alone, so "Reviews are
   * about the restaurant" was true of the record and false of the screen: a
   * branch manager could not see their own site's rating separately, and read
   * every other site's complaints instead.
   */
  const selection = await selectedBranch(user, await searchParams)
  const atBranch = selection.branchIds
    ? { order: { is: { branchId: { in: selection.branchIds } } } }
    : {}

  const [restaurant, reviews, agg] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.review.findMany({
      where: { restaurantId: user.restaurantId, ...atBranch },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        customer: { select: { name: true } },
        order: { select: { orderNumber: true, branch: { select: { name: true } } } },
      },
    }),
    // The average has to narrow with the list, or the headline figure is the
    // group's while the rows under it are one branch's.
    prisma.review.aggregate({
      where: { restaurantId: user.restaurantId, ...atBranch },
      _avg: { rating: true },
    }),
  ])

  return (
    <ReviewsManager
      average={agg._avg.rating ?? 0}
      locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
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
