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
 *   1. an explicit slug in the path — unambiguous, so it always wins,
 *   2. the request host — a verified custom domain, then a
 *      `<slug>.example.com` subdomain,
 *   3. the `ros_r` cookie, which only pins a choice on the SHARED domain,
 *   4. single-tenant fallback: the only active restaurant on the instance.
 *
 * ── Why the cookie sits below the host ──────────────────────────────────────
 *
 * It used to sit above it, and this docstring used to claim custom domains
 * worked when nothing implemented them. Both mattered the moment a restaurant
 * got its own address: a guest who scanned one restaurant's code in the morning
 * carries `ros_r` for twelve hours, and on `nilaza.lk` that stale cookie would
 * have shown them the wrong restaurant's menu on the right restaurant's domain.
 *
 * A hostname is a stronger statement than a cookie. The cookie exists to
 * survive client-side navigation where the URL carries no slug, which is a
 * shared-domain problem; where the host names a tenant, the host is the answer.
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
  | 'customDomain'
  | 'customDomainVerifiedAt'
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
  | 'targetFoodCostBps'
  | 'phone'
  | 'addressLine'
  | 'city'
  | 'isActive'
  | 'openingHours'
  | 'theme'
  | 'paymentConfig'
  | 'printerConfig'
  | 'loyaltyEnabled'
  | 'loyaltyEarnRateX100'
  | 'loyaltyPointValue'
>

const SUMMARY_SELECT = {
  id: true,
  slug: true,
  customDomain: true,
  customDomainVerifiedAt: true,
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
  targetFoodCostBps: true,
  phone: true,
  addressLine: true,
  city: true,
  isActive: true,
  openingHours: true,
  theme: true,
  paymentConfig: true,
  printerConfig: true,
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

/**
 * The hostname, reduced to the one shape domains are stored in.
 *
 * Lower-cased, port dropped, `www.` dropped. A guest may type any of
 * `nilaza.lk`, `www.nilaza.lk`, `NILAZA.LK` or hit `nilaza.lk:3000` in
 * development, and all four have to find the same restaurant.
 */
export function normaliseHost(host: string | null | undefined): string | null {
  if (!host) return null
  const bare = host.split(':')[0].trim().toLowerCase().replace(/\.$/, '')
  if (!bare || bare === 'localhost' || bare.startsWith('127.')) return null
  return bare.startsWith('www.') ? bare.slice(4) : bare
}

/**
 * The hostname the browser actually asked for.
 *
 * `x-forwarded-host` first. Behind a proxy — which is every real deployment of
 * this, Netlify included — `host` is whatever the proxy used internally, and
 * only the forwarded header carries what the visitor typed. Reading `host`
 * alone made a verified custom domain resolve on the root page (which read the
 * forwarded one) and 404 on `/api/public/whoami` (which did not), so the
 * verification check could never pass.
 *
 * `host` remains the fallback for local development and any un-proxied host.
 */
export async function requestHost(): Promise<string | null> {
  const store = await headers()
  return normaliseHost(store.get('x-forwarded-host') ?? store.get('host'))
}

/** The restaurant that owns a hostname, if one does and it has been verified. */
export const getRestaurantByDomain = cache(
  async (host: string): Promise<TenantSummary | null> => {
    const domain = normaliseHost(host)
    if (!domain) return null
    return prisma.restaurant.findFirst({
      where: {
        customDomain: domain,
        // Unverified is not a claim, it is an intention. Resolving on it would
        // let a row alone aim a hostname at somebody else's menu.
        customDomainVerifiedAt: { not: null },
        isActive: true,
      },
      select: SUMMARY_SELECT,
    })
  },
)

/** Resolve the public tenant for the QR-ordering surface. */
export const resolvePublicTenant = cache(
  async (slugFromPath?: string): Promise<TenantSummary | null> => {
    // 1. An explicit slug in the path says exactly which restaurant this is.
    if (slugFromPath) {
      const bySlug = await getRestaurantBySlug(slugFromPath)
      if (bySlug) return bySlug
    }

    // 2. The host. A verified domain first, then <slug>.example.com.
    const host = await requestHost()
    if (host) {
      const byDomain = await getRestaurantByDomain(host)
      if (byDomain) return byDomain

      const [subdomain, ...rest] = host.split('.')
      if (rest.length >= 2 && subdomain && subdomain !== 'www' && subdomain !== 'app') {
        const bySubdomain = await getRestaurantBySlug(subdomain)
        if (bySubdomain) return bySubdomain
      }
    }

    // 3. The cookie — a pin from an earlier page on the shared domain.
    const pinned = (await cookies()).get(TENANT_COOKIE)?.value
    if (pinned) {
      const byCookie = await getRestaurantBySlug(pinned)
      if (byCookie) return byCookie
    }

    // 4. Single-restaurant deployment: exactly one active restaurant, so a bare
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
