import 'server-only'
import type { RestaurantStatus } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

export interface PlatformRestaurant {
  id: string
  name: string
  slug: string
  customDomain: string | null
  customDomainVerified: boolean
  email: string | null
  phone: string | null
  city: string | null
  currency: string
  plan: string
  status: RestaurantStatus
  trialEndsAt: string | null
  createdAt: string
  approvedAt: string | null
  rejectionReason: string | null
  ownerName: string | null
  ownerEmail: string | null
  staffCount: number
  orderCount: number
  /**
   * Their own website's connection (websiteconnect.md), or null when no key
   * has been issued. Dates are ISO strings like every other date here.
   */
  website: {
    keyHint: string
    keyIssuedAt: string
    websiteUrl: string | null
    connectedAt: string | null
    lastSeenAt: string | null
    orderCount: number
  } | null
  /** The locations a website order can be sent to, default first. */
  branches: Array<{ id: string; name: string; code: string; isDefault: boolean }>
}

export interface PlatformFeedbackItem {
  id: string
  restaurantName: string
  restaurantSlug: string
  category: 'FOOD' | 'SYSTEM'
  rating: number
  comment: string | null
  createdAt: string
}

export interface RestaurantMenuSnapshotItem {
  id: string
  restaurantId: string
  restaurantName: string
  restaurantSlug: string
  entityType: 'CATEGORY' | 'FOOD'
  entityId: string
  name: string
  slug: string | null
  categoryName: string | null
  imageUrl: string | null
  price: number | null
  createdAt: string
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
      websiteConnection: {
        select: {
          keyHint: true, keyIssuedAt: true, websiteUrl: true,
          connectedAt: true, lastSeenAt: true, orderCount: true,
        },
      },
      branches: {
        where: { deletedAt: null, isActive: true, type: 'BRANCH' },
        select: { id: true, name: true, code: true, isDefault: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      },
    },
  })

  return restaurants.map((restaurant) => ({
    id: restaurant.id,
    name: restaurant.name,
    slug: restaurant.slug,
    customDomain: restaurant.customDomain,
    customDomainVerified: restaurant.customDomainVerifiedAt !== null,
    email: restaurant.email,
    phone: restaurant.phone,
    city: restaurant.city,
    currency: restaurant.currency,
    plan: restaurant.plan,
    status: restaurant.status,
    trialEndsAt: restaurant.trialEndsAt?.toISOString() ?? null,
    createdAt: restaurant.createdAt.toISOString(),
    approvedAt: restaurant.approvedAt?.toISOString() ?? null,
    rejectionReason: restaurant.rejectionReason,
    ownerName: restaurant.users[0]?.name ?? null,
    ownerEmail: restaurant.users[0]?.email ?? null,
    staffCount: restaurant._count.users,
    orderCount: restaurant._count.orders,
    website: restaurant.websiteConnection
      ? {
          keyHint: restaurant.websiteConnection.keyHint,
          keyIssuedAt: restaurant.websiteConnection.keyIssuedAt.toISOString(),
          websiteUrl: restaurant.websiteConnection.websiteUrl,
          connectedAt: restaurant.websiteConnection.connectedAt?.toISOString() ?? null,
          lastSeenAt: restaurant.websiteConnection.lastSeenAt?.toISOString() ?? null,
          orderCount: restaurant.websiteConnection.orderCount,
        }
      : null,
    branches: restaurant.branches,
  }))
}

export async function listRecentPlatformFeedback(limit = 8): Promise<PlatformFeedbackItem[]> {
  const feedback = await prisma.feedback.findMany({
    where: { category: { in: ['FOOD', 'SYSTEM'] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { restaurant: { select: { name: true, slug: true } } },
  })

  return feedback.map((item) => ({
    id: item.id,
    restaurantName: item.restaurant.name,
    restaurantSlug: item.restaurant.slug,
    category: item.category,
    rating: item.rating,
    comment: item.comment,
    createdAt: item.createdAt.toISOString(),
  }))
}

export async function listRecentRestaurantMenuSnapshots(limit = 12): Promise<RestaurantMenuSnapshotItem[]> {
  const rows = await prisma.restaurantMenuSnapshot.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { restaurant: { select: { name: true, slug: true } } },
  })

  return rows.map((row) => ({
    id: row.id,
    restaurantId: row.restaurantId,
    restaurantName: row.restaurant.name,
    restaurantSlug: row.restaurant.slug,
    entityType: row.entityType as 'CATEGORY' | 'FOOD',
    entityId: row.entityId,
    name: row.name,
    slug: row.slug,
    categoryName: row.categoryName,
    imageUrl: row.imageUrl,
    price: row.price,
    createdAt: row.createdAt.toISOString(),
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
