import 'server-only'

import type { Prisma } from '@prisma/client'

import { customersAtBranch } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'

/**
 * A slice of the customer list (pro.A.md §3, §4).
 *
 * ── One definition, three uses ──────────────────────────────────────────────
 *
 * The same object filters the list on screen, counts the people in it, and is
 * saved on a coupon to decide who the discount reaches. That matters more than
 * it sounds: the failure mode of a campaign feature is a screen that says
 * "184 customers" and a discount that reaches a different 184, because the
 * screen filtered in one place and the engine matched in another. There is one
 * `buildWhere` and everything calls it.
 *
 * ── Why the counters and not the orders ─────────────────────────────────────
 *
 * Visits and spend read `Customer.totalOrders` / `totalSpent`, which the order
 * and payment paths maintain. A segment has to be cheap enough to evaluate on
 * every order at the till, and re-aggregating a customer's whole history at
 * that moment is not. The insights figures are computed from orders and say so;
 * a segment is a coarser, faster question.
 */
export interface CustomerSegment {
  /** Free text over name, phone and email. */
  q?: string
  categoryId?: string
  /** Visit count, inclusive. */
  minVisits?: number
  maxVisits?: number
  /** Lifetime spend in minor units, inclusive. */
  minSpent?: number
  maxSpent?: number
  /** Last visit before this many days ago — "has not been in for 30 days". */
  notSeenForDays?: number
  /** Last visit within this many days — "came in this month". */
  seenWithinDays?: number
  /** First visit on or after this date, as YYYY-MM-DD. */
  firstSeenFrom?: string
  firstSeenTo?: string
  minPoints?: number
  /** `true` excludes blocked customers, `false` shows only them. */
  active?: boolean
  /**
   * A named class, defined once here so "regular" means the same thing on the
   * screen, in the count and in the campaign.
   */
  kind?: CustomerKind
}

/**
 * The words people actually use, given numbers.
 *
 * These are judgements, not facts, so they live in one place with the reasons
 * written down rather than being re-guessed per screen:
 *
 *   new       — one visit. They have tried you.
 *   returning — two or more. They came back at least once.
 *   repeat    — three or more. Not an accident.
 *   regular   — five or more AND seen in the last 60 days. Frequency alone is
 *               not enough; somebody who came ten times two years ago is
 *               lapsed, not regular.
 *   lapsed    — two or more visits and nothing for 45 days. One visit and
 *               silence is not lapsed, it is a stranger.
 */
export type CustomerKind = 'new' | 'returning' | 'repeat' | 'regular' | 'lapsed'

export const CUSTOMER_KIND_LABEL: Record<CustomerKind, string> = {
  new: 'New (1 visit)',
  returning: 'Returning (2+)',
  repeat: 'Repeat (3+)',
  regular: 'Regular (5+, seen recently)',
  lapsed: 'Lapsed (2+, away 45 days)',
}

const REGULAR_VISITS = 5
const REGULAR_WITHIN_DAYS = 60
const LAPSED_AFTER_DAYS = 45

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 86_400_000)
}

/**
 * The Prisma filter for a segment, inside the caller's branch reach.
 *
 * `branchIds` is the usual convention: `null` for every location, `[]` for
 * none. It is applied through `customersAtBranch`, which reaches a customer
 * through their orders — and because that helper returns a bare `OR`, it is
 * nested inside `AND` here so it can never be overwritten by another clause.
 */
export function buildSegmentWhere(params: {
  restaurantId: string
  branchIds: string[] | null
  segment: CustomerSegment
  now?: Date
}): Prisma.CustomerWhereInput {
  const { segment } = params
  const now = params.now ?? new Date()
  const and: Prisma.CustomerWhereInput[] = [customersAtBranch(params.branchIds)]

  const term = segment.q?.trim()
  if (term) {
    and.push({
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term } },
        { email: { contains: term, mode: 'insensitive' } },
      ],
    })
  }

  if (segment.categoryId) and.push({ categoryId: segment.categoryId })

  const visits: Prisma.IntFilter = {}
  if (segment.minVisits !== undefined) visits.gte = segment.minVisits
  if (segment.maxVisits !== undefined) visits.lte = segment.maxVisits

  const spent: Prisma.IntFilter = {}
  if (segment.minSpent !== undefined) spent.gte = segment.minSpent
  if (segment.maxSpent !== undefined) spent.lte = segment.maxSpent

  const lastOrder: Prisma.DateTimeNullableFilter = {}
  if (segment.notSeenForDays !== undefined) lastOrder.lt = daysAgo(segment.notSeenForDays, now)
  if (segment.seenWithinDays !== undefined) lastOrder.gte = daysAgo(segment.seenWithinDays, now)

  const firstOrder: Prisma.DateTimeNullableFilter = {}
  if (segment.firstSeenFrom) firstOrder.gte = new Date(`${segment.firstSeenFrom}T00:00:00.000Z`)
  if (segment.firstSeenTo) firstOrder.lte = new Date(`${segment.firstSeenTo}T23:59:59.999Z`)

  // A named class narrows the same columns, so it composes with the rest.
  switch (segment.kind) {
    case 'new':
      visits.lte = Math.min(visits.lte ?? 1, 1)
      visits.gte = Math.max(visits.gte ?? 1, 1)
      break
    case 'returning':
      visits.gte = Math.max(visits.gte ?? 2, 2)
      break
    case 'repeat':
      visits.gte = Math.max(visits.gte ?? 3, 3)
      break
    case 'regular':
      visits.gte = Math.max(visits.gte ?? REGULAR_VISITS, REGULAR_VISITS)
      lastOrder.gte = daysAgo(REGULAR_WITHIN_DAYS, now)
      break
    case 'lapsed':
      visits.gte = Math.max(visits.gte ?? 2, 2)
      lastOrder.lt = daysAgo(LAPSED_AFTER_DAYS, now)
      break
    default:
      break
  }

  if (Object.keys(visits).length) and.push({ totalOrders: visits })
  if (Object.keys(spent).length) and.push({ totalSpent: spent })
  if (Object.keys(lastOrder).length) and.push({ lastOrderAt: lastOrder })
  if (Object.keys(firstOrder).length) and.push({ firstOrderAt: firstOrder })
  if (segment.minPoints !== undefined) and.push({ loyaltyPoints: { gte: segment.minPoints } })
  if (segment.active !== undefined) and.push({ isBlocked: !segment.active })

  return { restaurantId: params.restaurantId, AND: and }
}

/** How many people a segment reaches. The number the campaign button quotes. */
export async function countSegment(params: {
  restaurantId: string
  branchIds: string[] | null
  segment: CustomerSegment
}): Promise<number> {
  return prisma.customer.count({ where: buildSegmentWhere(params) })
}

/** A page of the segment, newest visitors first. */
export async function listSegment(params: {
  restaurantId: string
  branchIds: string[] | null
  segment: CustomerSegment
  page?: number
  perPage?: number
}) {
  const perPage = Math.min(Math.max(params.perPage ?? 50, 1), 200)
  const page = Math.max(params.page ?? 1, 1)
  const where = buildSegmentWhere(params)

  const [rows, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: [{ lastOrderAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage,
      include: { category: { select: { id: true, name: true } } },
    }),
    prisma.customer.count({ where }),
  ])

  return { rows, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) }
}

/**
 * Does this customer fall inside a saved segment?
 *
 * Used by the discount engine at order time. One indexed count rather than
 * re-deriving the filter in another language — the segment is whatever
 * `buildSegmentWhere` says it is, here as everywhere else.
 */
export async function customerInSegment(params: {
  restaurantId: string
  customerId: string
  segment: CustomerSegment
}): Promise<boolean> {
  const found = await prisma.customer.count({
    where: {
      ...buildSegmentWhere({
        restaurantId: params.restaurantId,
        // A campaign is defined for the whole business; branch reach is a
        // property of who is LOOKING at the list, not of who it applies to.
        branchIds: null,
        segment: params.segment,
      }),
      id: params.customerId,
    },
  })
  return found > 0
}

/** Read a segment off a coupon's JSON column, defensively. */
export function readSegment(value: unknown): CustomerSegment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const segment = value as CustomerSegment
  const empty =
    segment.q === undefined &&
    segment.categoryId === undefined &&
    segment.minVisits === undefined &&
    segment.maxVisits === undefined &&
    segment.minSpent === undefined &&
    segment.maxSpent === undefined &&
    segment.notSeenForDays === undefined &&
    segment.seenWithinDays === undefined &&
    segment.firstSeenFrom === undefined &&
    segment.firstSeenTo === undefined &&
    segment.minPoints === undefined &&
    segment.active === undefined &&
    segment.kind === undefined
  return empty ? null : segment
}

/** Turn a segment into the sentence a person would say. */
export function describeSegment(segment: CustomerSegment, categoryName?: string | null): string {
  const parts: string[] = []
  if (segment.kind) parts.push(CUSTOMER_KIND_LABEL[segment.kind].toLowerCase())
  if (categoryName) parts.push(`in ${categoryName}`)
  if (segment.minVisits !== undefined) parts.push(`${segment.minVisits}+ visits`)
  if (segment.maxVisits !== undefined) parts.push(`at most ${segment.maxVisits} visits`)
  if (segment.minSpent !== undefined) parts.push(`spent ${Math.round(segment.minSpent / 100)}+`)
  if (segment.notSeenForDays !== undefined) parts.push(`away ${segment.notSeenForDays}+ days`)
  if (segment.seenWithinDays !== undefined) parts.push(`seen in ${segment.seenWithinDays} days`)
  if (segment.minPoints !== undefined) parts.push(`${segment.minPoints}+ points`)
  if (segment.q) parts.push(`matching “${segment.q}”`)
  return parts.length ? parts.join(', ') : 'everybody'
}
