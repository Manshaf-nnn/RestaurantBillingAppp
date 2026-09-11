import 'server-only'
import type { Order, OrderItem, WebsiteConnection } from '@prisma/client'

import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { placeOrder } from '@/features/orders/service'
import { readOptions } from '@/features/orders/queries'
import { generateToken, hashToken } from '@/server/auth/password'
import { prisma } from '@/server/db/prisma'
import { getRestaurantById, type TenantSummary } from '@/server/db/tenant'
import type { WebsiteOrderInput } from './schema'

/**
 * A restaurant's own website, connected to TableFlow (websiteconnect.md).
 *
 * ── What "connected" means here ─────────────────────────────────────────────
 *
 * There is no handshake and no gateway. A website is connected when it holds
 * a key that TableFlow issued for exactly one restaurant, and every request it
 * makes with that key is answered from that restaurant's data and nobody
 * else's. The key IS the connection: the restaurant id in the response is
 * derived from the key, never read from the request, which is the whole of
 * the cross-tenant rule. A website cannot ask for another restaurant's menu
 * because there is no parameter through which to ask.
 *
 * ── The key is shown once ───────────────────────────────────────────────────
 *
 * Only its SHA-256 is stored, the same rule refresh tokens follow. An operator
 * who loses the key regenerates it; TableFlow cannot show it again because it
 * does not have it. That is a smaller inconvenience than a database that hands
 * out working credentials to whoever reads it.
 *
 * ── Why this module owns the order call ─────────────────────────────────────
 *
 * Website orders go through `placeOrder` — the same function the QR menu and
 * the till use — so they land in the kitchen display, the POS queue, the
 * outbox, notifications, inventory and reports with no pipeline of their own.
 * This module only translates a website's request into that call and stamps
 * `channel: ONLINE` so reports can tell the two apart.
 */

export const WEBSITE_KEY_PREFIX = 'tfk_'

/** A fresh key, its hash, and the four characters an operator sees afterwards. */
export function mintWebsiteKey(): { key: string; hash: string; hint: string } {
  const key = `${WEBSITE_KEY_PREFIX}${generateToken(32)}`
  return { key, hash: hashToken(key), hint: key.slice(-4) }
}

export async function getWebsiteConnection(restaurantId: string): Promise<WebsiteConnection | null> {
  return prisma.websiteConnection.findUnique({ where: { restaurantId } })
}

/**
 * Issue a key — the first one, or a replacement.
 *
 * Regenerating resets `connectedAt`: a new key is a new claim, and whatever
 * the old key proved, this one has not proved yet. The order count survives,
 * because the orders happened.
 */
export async function issueWebsiteKey(params: {
  restaurantId: string
  websiteUrl?: string | null
  actorId?: string | null
}): Promise<{
  key: string
  connection: WebsiteConnection
  regenerated: boolean
  previousHint: string | null
}> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: params.restaurantId },
    select: { id: true },
  })
  if (!restaurant) throw new NotFoundError('Restaurant')

  const existing = await getWebsiteConnection(params.restaurantId)
  const minted = mintWebsiteKey()

  const connection = await prisma.websiteConnection.upsert({
    where: { restaurantId: params.restaurantId },
    create: {
      restaurantId: params.restaurantId,
      keyHash: minted.hash,
      keyHint: minted.hint,
      websiteUrl: params.websiteUrl || null,
      createdById: params.actorId ?? null,
    },
    update: {
      keyHash: minted.hash,
      keyHint: minted.hint,
      keyIssuedAt: new Date(),
      connectedAt: null,
      lastSeenAt: null,
      // Only when the form sent one, so rotating the key never blanks the
      // address recorded beside it.
      ...(params.websiteUrl === undefined ? {} : { websiteUrl: params.websiteUrl || null }),
    },
  })

  return {
    key: minted.key,
    connection,
    regenerated: existing !== null,
    previousHint: existing?.keyHint ?? null,
  }
}

export async function setWebsiteUrl(
  restaurantId: string,
  websiteUrl: string | null,
): Promise<WebsiteConnection> {
  const existing = await getWebsiteConnection(restaurantId)
  if (!existing) throw new NotFoundError('Website connection')
  return prisma.websiteConnection.update({
    where: { id: existing.id },
    data: { websiteUrl: websiteUrl || null },
  })
}

/** Cut the website off. The key stops working on its next request. */
export async function disconnectWebsite(restaurantId: string): Promise<WebsiteConnection | null> {
  const existing = await getWebsiteConnection(restaurantId)
  if (!existing) return null
  await prisma.websiteConnection.delete({ where: { id: existing.id } })
  return existing
}

// ── authentication ───────────────────────────────────────────────────────────

export interface WebsiteCaller {
  connection: WebsiteConnection
  restaurant: TenantSummary
}

/** The token from an `Authorization: Bearer …` header, or null. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null
  const [scheme, token] = header.trim().split(/\s+/, 2)
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

/**
 * Who is calling, from the key alone.
 *
 * One refusal message for "no key", "malformed key" and "unknown key" — a
 * caller who can tell those apart is a caller enumerating keys. The message
 * still says what to do about it, because the person reading it is a website
 * developer with a typo, far more often than an attacker.
 */
export async function authenticateWebsiteKey(presented: string | null): Promise<WebsiteCaller> {
  const refused = () =>
    new AppError(
      'That key is not valid. Check TABLEFLOW_API_KEY, or regenerate it under Connect Website in TableFlow.',
      401,
      'INVALID_KEY',
    )

  if (!presented || !presented.startsWith(WEBSITE_KEY_PREFIX)) throw refused()

  const connection = await prisma.websiteConnection.findUnique({
    where: { keyHash: hashToken(presented) },
  })
  if (!connection) throw refused()

  // `getRestaurantById` already refuses an inactive restaurant; the explicit
  // check is so a suspended tenant's website reads "not active", not "no key".
  const restaurant = await getRestaurantById(connection.restaurantId)
  if (!restaurant || !restaurant.isActive) {
    throw new ForbiddenError('This restaurant is not active on TableFlow')
  }

  return { connection, restaurant }
}

const TOUCH_INTERVAL_MS = 60_000

/**
 * Record that the key was used.
 *
 * The first use is what turns "waiting for the website" into "connected"; after
 * that, `lastSeenAt` is refreshed at most once a minute so a busy site's menu
 * fetches do not each cost a write.
 */
export async function touchWebsiteConnection(connection: WebsiteConnection): Promise<void> {
  const now = new Date()
  const fresh =
    connection.connectedAt !== null &&
    connection.lastSeenAt !== null &&
    now.getTime() - connection.lastSeenAt.getTime() < TOUCH_INTERVAL_MS
  if (fresh) return

  await prisma.websiteConnection.update({
    where: { id: connection.id },
    data: {
      lastSeenAt: now,
      ...(connection.connectedAt ? {} : { connectedAt: now }),
    },
  })
}

// ── branches ─────────────────────────────────────────────────────────────────

const BRANCH_SELECT = { id: true, name: true, code: true, address: true, isDefault: true } as const
export type WebsiteBranch = { id: string; name: string; code: string; address: string | null; isDefault: boolean }

const ORDERABLE = { deletedAt: null, isActive: true, type: 'BRANCH' as const }

/** Every location a website order can be sent to, default first. */
export async function listWebsiteBranches(restaurantId: string): Promise<WebsiteBranch[]> {
  return prisma.branch.findMany({
    where: { restaurantId, ...ORDERABLE },
    select: BRANCH_SELECT,
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
}

/**
 * The branch a request means, by id or by code — or the default when it says
 * nothing.
 *
 * Its own resolver rather than `resolvePublicBranch`, because that one falls
 * back to a cookie a server-to-server caller never has, and a website that
 * omitted the branch would silently be served whichever branch a cookie last
 * named. A named branch that matches nothing is refused, not defaulted: a
 * wrong branch is a wrong price.
 */
export async function resolveWebsiteBranch(
  restaurantId: string,
  reference?: string | null,
): Promise<WebsiteBranch> {
  const wanted = reference?.trim()
  if (wanted) {
    const branch = await prisma.branch.findFirst({
      where: { restaurantId, ...ORDERABLE, OR: [{ id: wanted }, { code: wanted.toUpperCase() }] },
      select: BRANCH_SELECT,
    })
    if (!branch) {
      throw new NotFoundError(
        `Branch "${wanted}" — use one of the ids or codes GET /connection lists`,
      )
    }
    return branch
  }

  const fallback = await prisma.branch.findFirst({
    where: { restaurantId, ...ORDERABLE },
    select: BRANCH_SELECT,
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
  if (!fallback) throw new NotFoundError('A branch that takes orders')
  return fallback
}

// ── what the website is shown ────────────────────────────────────────────────

/** A stored image path made reachable from another origin. */
export function absoluteMediaUrl(url: string | null | undefined, origin: string): string | null {
  if (!url) return null
  return url.startsWith('/') ? `${origin}${url}` : url
}

/**
 * The restaurant as its website may see it.
 *
 * Built by hand rather than by spreading `TenantSummary`, because that shape
 * also carries `paymentConfig`, `printerConfig`, `receiptConfig` and the
 * food-cost target — internal configuration that has no business on a public
 * website's server, let alone in its page source.
 */
export function websiteRestaurantView(
  restaurant: TenantSummary,
  origin: string,
  branches: WebsiteBranch[],
) {
  return {
    id: restaurant.id,
    slug: restaurant.slug,
    name: restaurant.name,
    tagline: restaurant.tagline,
    logoUrl: absoluteMediaUrl(restaurant.logoUrl, origin),
    coverUrl: absoluteMediaUrl(restaurant.coverUrl, origin),
    currency: restaurant.currency,
    locale: restaurant.locale,
    timezone: restaurant.timezone,
    tax: {
      label: restaurant.taxLabel,
      ratePercent: restaurant.taxRateBps / 100,
      inclusive: restaurant.taxInclusive,
    },
    serviceChargePercent: restaurant.serviceChargeBps / 100,
    phone: restaurant.phone,
    addressLine: restaurant.addressLine,
    city: restaurant.city,
    openingHours: restaurant.openingHours,
    theme: restaurant.theme,
    branches,
  }
}

// ── orders ───────────────────────────────────────────────────────────────────

type OrderWithLines = Order & {
  items: OrderItem[]
  branch: { id: string; name: string; code: string } | null
}

/**
 * One order, as its website may read it.
 *
 * Fenced by `restaurantId` — the tenant rule — and by `channel: ONLINE`, so a
 * website reads back the orders it placed and not the dining room's. Ids are
 * cuids and unguessable; the fence is still the fence.
 */
export async function getOrderForWebsite(
  restaurantId: string,
  orderId: string,
): Promise<OrderWithLines | null> {
  return prisma.order.findFirst({
    where: { id: orderId, restaurantId, channel: 'ONLINE' },
    include: { items: true, branch: { select: { id: true, name: true, code: true } } },
  })
}

/** Money is in minor units throughout, as everywhere else in TableFlow. */
export function websiteOrderView(order: OrderWithLines) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    type: order.type,
    placedAt: order.placedAt.toISOString(),
    estimatedMinutes: order.estimatedMinutes,
    branch: order.branch,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    notes: order.notes,
    subtotal: order.subtotal,
    discountTotal: order.discountTotal,
    serviceCharge: order.serviceCharge,
    taxTotal: order.taxTotal,
    grandTotal: order.grandTotal,
    paidTotal: order.paidTotal,
    items: order.items.map((item) => ({
      id: item.id,
      foodId: item.foodId,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      status: item.status,
      notes: item.notes,
      options: readOptions(item.options).map((option) => option.name),
    })),
  }
}

/**
 * Place an order for the website's restaurant.
 *
 * The delivery address rides in the order's notes. `Order` has no address
 * column — deliveries have always been keyed in by staff with the address in
 * the notes — and adding one for this alone would give website orders a field
 * the till cannot see. The kitchen ticket and the POS both print notes.
 */
export async function placeWebsiteOrder(
  caller: WebsiteCaller,
  input: WebsiteOrderInput,
): Promise<OrderWithLines> {
  const branch = await resolveWebsiteBranch(caller.restaurant.id, input.branch)

  const notes = [
    input.type === 'DELIVERY' && input.deliveryAddress ? `Deliver to: ${input.deliveryAddress}` : '',
    input.notes ?? '',
  ]
    .filter(Boolean)
    .join(' · ')

  const started = Date.now()
  const placed = await placeOrder({
    restaurantId: caller.restaurant.id,
    branchId: branch.id,
    tableId: null,
    type: input.type,
    channel: 'ONLINE',
    customerName: input.customerName,
    customerPhone: input.customerPhone || '',
    customerEmail: input.customerEmail || null,
    notes: notes || null,
    items: input.items.map((item) => ({
      foodId: item.foodId,
      quantity: item.quantity,
      optionIds: item.optionIds ?? [],
      notes: item.notes || undefined,
    })),
    couponCode: input.couponCode || null,
    idempotencyKey: input.idempotencyKey || null,
  })

  // A replay under the same idempotency key returns the order that already
  // exists — placed before this call began — and is not a second order.
  if (placed.placedAt.getTime() >= started) {
    await prisma.websiteConnection.update({
      where: { id: caller.connection.id },
      data: { orderCount: { increment: 1 } },
    })
  }

  const order = await getOrderForWebsite(caller.restaurant.id, placed.id)
  if (!order) throw new NotFoundError('Order')
  return order
}
