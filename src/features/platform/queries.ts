import 'server-only'
import type { RestaurantStatus } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

export interface PlatformRestaurant {
  id: string
  name: string
  slug: string
  email: string | null
  phone: string | null
  city: string | null
  currency: string
  plan: string
  status: RestaurantStatus
  createdAt: string
  approvedAt: string | null
  rejectionReason: string | null
  ownerName: string | null
  ownerEmail: string | null
  staffCount: number
  orderCount: number
}

/** Every tenant on the platform, newest first, with owner + basic counts. */
export async function listPlatformRestaurants(status?: RestaurantStatus): Promise<PlatformRestaurant[]> {
  const restaurants = await prisma.restaurant.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    include: {
      users: {
        where: { role: 'OWNER', deletedAt: null },
        select: { name: true, email: true },
        take: 1,
      },
      _count: {
        select: {
          users: { where: { deletedAt: null } },
          orders: true,
        },
      },
    },
  })

  return restaurants.map((restaurant) => ({
    id: restaurant.id,
    name: restaurant.name,
    slug: restaurant.slug,
    email: restaurant.email,
    phone: restaurant.phone,
    city: restaurant.city,
    currency: restaurant.currency,
    plan: restaurant.plan,
    status: restaurant.status,
    createdAt: restaurant.createdAt.toISOString(),
    approvedAt: restaurant.approvedAt?.toISOString() ?? null,
    rejectionReason: restaurant.rejectionReason,
    ownerName: restaurant.users[0]?.name ?? null,
    ownerEmail: restaurant.users[0]?.email ?? null,
    staffCount: restaurant._count.users,
    orderCount: restaurant._count.orders,
  }))
}

export interface PlatformStats {
  total: number
  pending: number
  active: number
  suspended: number
  rejected: number
  totalStaff: number
  totalOrders: number
}

export async function getPlatformStats(): Promise<PlatformStats> {
  const [byStatus, staff, orders] = await Promise.all([
    prisma.restaurant.groupBy({ by: ['status'], _count: true }),
    prisma.user.count({ where: { deletedAt: null, role: { not: 'SUPER_ADMIN' } } }),
    prisma.order.count(),
  ])

  const count = (status: RestaurantStatus) =>
    byStatus.find((row) => row.status === status)?._count ?? 0

  return {
    total: byStatus.reduce((sum, row) => sum + row._count, 0),
    pending: count('PENDING'),
    active: count('ACTIVE'),
    suspended: count('SUSPENDED'),
    rejected: count('REJECTED'),
    totalStaff: staff,
    totalOrders: orders,
  }
}
