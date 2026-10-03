import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * What riders have earned from the deliveries they closed.
 *
 * A delivery earns its rider `Order.deliveryPay` — the owner's per-delivery
 * rate, stamped on the order when the customer's PIN closed it (see
 * `completeDeliveryWithPin`). Everything here is a sum of those stamps, so it
 * cannot disagree with the orders it came from and nobody can edit it: the
 * only way to change what a rider is owed is to deliver, or not.
 *
 * Counted by when the delivery was CLOSED (`servedAt`) — a rider is paid for
 * the day they rode, not the day the order was placed.
 */

export interface RiderPayFigure {
  delivered: number
  earned: number
}

export interface RiderPay {
  /** The owner's current per-delivery pay, minor units. */
  rate: number
  mine: { today: RiderPayFigure; month: RiderPayFigure }
  /** Every rider with a delivery this month, most earned first. Empty unless asked for. */
  riders: Array<{ id: string; name: string; today: RiderPayFigure; month: RiderPayFigure }>
}

const NONE: RiderPayFigure = { delivered: 0, earned: 0 }

export async function getRiderPay(params: {
  restaurantId: string
  /** Null is every location. */
  branchIds: string[] | null
  riderId: string
  today: { from: Date; to: Date }
  month: { from: Date; to: Date }
  /** Also return every rider's figures — for whoever pays them. */
  everyone?: boolean
}): Promise<RiderPay> {
  const scope = {
    restaurantId: params.restaurantId,
    type: 'DELIVERY' as const,
    status: { in: ['SERVED', 'COMPLETED'] as Array<'SERVED' | 'COMPLETED'> },
    servedById: params.everyone ? { not: null } : params.riderId,
    ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
  }
  const grouped = (window: { from: Date; to: Date }) =>
    prisma.order.groupBy({
      by: ['servedById'],
      where: { ...scope, servedAt: { gte: window.from, lte: window.to } },
      _count: true,
      _sum: { deliveryPay: true },
    })

  const [today, month, restaurant] = await Promise.all([
    grouped(params.today),
    grouped(params.month),
    prisma.restaurant.findUniqueOrThrow({
      where: { id: params.restaurantId },
      select: { deliveryPayPerOrder: true },
    }),
  ])
  const rate = restaurant.deliveryPayPerOrder
  const figure = (rows: typeof today, id: string): RiderPayFigure => {
    const row = rows.find((entry) => entry.servedById === id)
    return row ? { delivered: row._count, earned: row._sum.deliveryPay ?? 0 } : NONE
  }

  const mine = { today: figure(today, params.riderId), month: figure(month, params.riderId) }
  if (!params.everyone) return { rate, mine, riders: [] }

  const ids = month.map((row) => row.servedById).filter((id): id is string => id !== null)
  const people = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids }, restaurantId: params.restaurantId },
        select: { id: true, name: true },
      })
    : []
  const nameOf = new Map(people.map((person) => [person.id, person.name]))

  return {
    rate,
    mine,
    riders: ids
      .map((id) => ({
        id,
        name: nameOf.get(id) ?? 'Former staff',
        today: figure(today, id),
        month: figure(month, id),
      }))
      .sort((a, b) => b.month.earned - a.month.earned || b.month.delivered - a.month.delivered),
  }
}
