import { customersAtBranch } from '@/lib/rbac'
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
export async function getLoyaltyOverview(
  restaurantId: string,
  /**
   * Locations the viewer may see. Null means all of them.
   *
   * The programme itself is restaurant-wide — one earn rate, one point value,
   * set on `Restaurant` — but the members list is people, and a branch manager
   * reads their own. The liability figure narrows with it, which is the honest
   * pairing: it should total the members shown, not a wider set.
   */
  branchIds?: string[] | null,
): Promise<LoyaltyOverview> {
  const [sum, members, top] = await Promise.all([
    prisma.customer.aggregate({
      where: { restaurantId, loyaltyPoints: { gt: 0 }, ...customersAtBranch(branchIds ?? null) },
      _sum: { loyaltyPoints: true },
    }),
    prisma.customer.count({ where: { restaurantId, loyaltyPoints: { gt: 0 }, ...customersAtBranch(branchIds ?? null) } }),
    prisma.customer.findMany({
      where: { restaurantId, loyaltyPoints: { gt: 0 }, ...customersAtBranch(branchIds ?? null) },
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
