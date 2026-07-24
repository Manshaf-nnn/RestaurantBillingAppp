import 'server-only'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import type { Restaurant } from '@prisma/client'

import { NotFoundError } from '@/lib/errors'
import { prisma } from './prisma'

/**
 * Tenant resolution.
 *
 * Staff surfaces derive the tenant from the authenticated user. The public
 * QR-ordering surface derives it from the URL, in this order:
 *
 *   1. an explicit slug (`/order?r=<slug>`, pinned to a cookie by middleware
 *      so it survives client-side navigation),
 *   2. the request host — custom domain, then `<slug>.example.com` subdomain,
 *   3. single-tenant fallback: the only active restaurant on the instance.
 *
 * Every tenant-scoped read is filtered by `restaurantId` at the query level.
 * No cross-tenant read is possible even if an id is guessed, because the id is
 * always paired with the tenant filter.
 */

/** Pins the QR-ordering session to one restaurant on a shared domain. */
export const TENANT_COOKIE = 'ros_r'

export type TenantSummary = Pick<
  Restaurant,
  | 'id'
  | 'slug'
  | 'name'
  | 'tagline'
  | 'logoUrl'
  | 'coverUrl'
  | 'currency'
  | 'locale'
  | 'timezone'
  | 'taxRateBps'
  | 'taxLabel'
  | 'taxInclusive'
  | 'serviceChargeBps'
  | 'phone'
  | 'addressLine'
  | 'city'
  | 'isActive'
  | 'openingHours'
  | 'theme'
  | 'paymentConfig'
  | 'loyaltyEnabled'
  | 'loyaltyEarnRateX100'
  | 'loyaltyPointValue'
>

const SUMMARY_SELECT = {
  id: true,
  slug: true,
  name: true,
  tagline: true,
  logoUrl: true,
  coverUrl: true,
  currency: true,
  locale: true,
  timezone: true,
  taxRateBps: true,
  taxLabel: true,
  taxInclusive: true,
  serviceChargeBps: true,
  phone: true,
  addressLine: true,
  city: true,
  isActive: true,
  openingHours: true,
  theme: true,
  paymentConfig: true,
  loyaltyEnabled: true,
  loyaltyEarnRateX100: true,
  loyaltyPointValue: true,
} as const

/** Per-request memoised lookup — many components ask for the tenant. */
export const getRestaurantById = cache(async (id: string): Promise<TenantSummary | null> => {
  return prisma.restaurant.findFirst({ where: { id, isActive: true }, select: SUMMARY_SELECT })
})

export const getRestaurantBySlug = cache(async (slug: string): Promise<TenantSummary | null> => {
  return prisma.restaurant.findFirst({
    where: { slug: slug.toLowerCase(), isActive: true },
    select: SUMMARY_SELECT,
  })
})

export async function requireRestaurant(id: string): Promise<TenantSummary> {
  const restaurant = await getRestaurantById(id)
  if (!restaurant) throw new NotFoundError('Restaurant')
  return restaurant
}

/** Resolve the public tenant for the QR-ordering surface. */
export const resolvePublicTenant = cache(
  async (slugFromPath?: string): Promise<TenantSummary | null> => {
    const explicit = slugFromPath ?? (await cookies()).get(TENANT_COOKIE)?.value
    if (explicit) {
      const bySlug = await getRestaurantBySlug(explicit)
      if (bySlug) return bySlug
    }

    const host = (await headers()).get('host')?.split(':')[0]?.toLowerCase()
    if (host && host !== 'localhost' && !host.startsWith('127.')) {
      const [subdomain, ...rest] = host.split('.')
      if (rest.length >= 2 && subdomain && subdomain !== 'www' && subdomain !== 'app') {
        const bySubdomain = await getRestaurantBySlug(subdomain)
        if (bySubdomain) return bySubdomain
      }
    }

    // Single-restaurant deployment: exactly one active restaurant, so a bare
    // `/order` (no slug) resolves to it. With several restaurants the URL is
    // ambiguous — guests must arrive via their QR link (`/order?r=<slug>`), so
    // we return null (→ 404) rather than guess and show the wrong menu.
    const all = await prisma.restaurant.findMany({
      where: { isActive: true },
      select: SUMMARY_SELECT,
      take: 2,
      orderBy: { createdAt: 'asc' },
    })
    return all.length === 1 ? all[0] : null
  },
)

/**
 * Guarantees a `where` clause carries the tenant filter.
 * Use as `where: scoped(restaurantId, { id })` — never `where: { id }`.
 */
export function scoped<T extends Record<string, unknown>>(
  restaurantId: string,
  where?: T,
): T & { restaurantId: string } {
  return { ...(where ?? ({} as T)), restaurantId }
}

/** Soft-delete aware variant. */
export function scopedActive<T extends Record<string, unknown>>(
  restaurantId: string,
  where?: T,
): T & { restaurantId: string; deletedAt: null } {
  return { ...(where ?? ({} as T)), restaurantId, deletedAt: null }
}
