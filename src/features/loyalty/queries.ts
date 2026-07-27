import { prisma } from '@/server/db/prisma'

export interface LoyaltyMember {
  id: string
  name: string
  phone: string
  loyaltyPoints: number
  totalOrders: number
  totalSpent: number
  lastOrderAt: string | null
}

export interface LoyaltyOverview {
  members: number
  pointsOutstanding: number
  topMembers: LoyaltyMember[]
}

/** Programme snapshot: how many guests are collecting points, the total points
 *  outstanding, and the most loyal guests. */
export async function getLoyaltyOverview(restaurantId: string): Promise<LoyaltyOverview> {
  const [sum, members, top] = await Promise.all([
    prisma.customer.aggregate({
      where: { restaurantId, loyaltyPoints: { gt: 0 } },
      _sum: { loyaltyPoints: true },
    }),
    prisma.customer.count({ where: { restaurantId, loyaltyPoints: { gt: 0 } } }),
    prisma.customer.findMany({
      where: { restaurantId, loyaltyPoints: { gt: 0 } },
      orderBy: { loyaltyPoints: 'desc' },
      take: 8,
      select: {
        id: true,
        name: true,
        phone: true,
        loyaltyPoints: true,
        totalOrders: true,
        totalSpent: true,
        lastOrderAt: true,
      },
    }),
  ])

  return {
    members,
    pointsOutstanding: sum._sum.loyaltyPoints ?? 0,
    topMembers: top.map((m) => ({
      id: m.id,
      name: m.name,
      phone: m.phone,
      loyaltyPoints: m.loyaltyPoints,
      totalOrders: m.totalOrders,
      totalSpent: m.totalSpent,
      lastOrderAt: m.lastOrderAt ? m.lastOrderAt.toISOString() : null,
    })),
  }
}
