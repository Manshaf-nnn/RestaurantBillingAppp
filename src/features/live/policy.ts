import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * What the live floor board treats as late, and who it treats as a regular.
 *
 * ── Why these are settings and not constants ────────────────────────────────
 *
 * Twenty minutes is a disaster in a coffee shop and brisk in a place that
 * grills to order. The same argument `getApprovalPolicy` already won for money
 * limits applies to time, so the numbers live on the restaurant with defaults
 * that work on day one — the board is useful before anybody configures it.
 *
 * Stored the same way, in a `Json?` column, merged over the defaults on read so
 * a column written before a new field existed still yields a complete object.
 *
 * ── Restaurant-level, deliberately ──────────────────────────────────────────
 *
 * No per-branch override. Nothing else in this schema has one — `Branch` has a
 * single Json column and it holds opening hours — so a branch override would be
 * a new mechanism rather than an instance of an existing one, invented for
 * thresholds nobody has yet wanted to vary. When somebody does, it is a column
 * on `Branch` and one more object in the spread below, not a rewrite.
 */

export interface LiveBoardPolicy {
  /*
   * ── Waiting bands, in minutes ─────────────────────────────────────────────
   *
   * Upper bounds, each one the last minute still counted as that band. A table
   * is NORMAL up to and including `normalMax`, WATCH up to `watchMax`, and so
   * on; past `delayedMax` it is critical. Validation keeps them increasing,
   * because bands that cross over would leave a gap no table could ever land in.
   */
  normalMax: number
  watchMax: number
  attentionMax: number
  delayedMax: number

  /* ── When a table needs somebody to go and look ──────────────────────────── */

  /** Nothing served at all after this long. */
  noFoodServedMin: number
  /** Food has been sitting in the kitchen this long since it was ready. */
  readyNotServedMin: number
  /** Still preparing this long after the kitchen started. */
  stuckPreparingMin: number
  /** Everything served, bill still unpaid this long afterwards. */
  paymentPendingMin: number
  /** A whole sitting running longer than this is worth a glance. */
  longServiceMin: number
  /** A guest worth greeting has been waiting this long. */
  sensitiveWaitingMin: number
  /** A call-waiter request nobody has answered. */
  serviceRequestMin: number
  /** "Barely anything served" — a percentage, for the low-progress alert. */
  lowProgressPct: number

  /* ── Who counts as a regular ─────────────────────────────────────────────── */

  /** Completed visits at or above this: REGULAR. */
  regularAfterVisits: number
  /** Completed visits at or above this: VIP. */
  vipAfterVisits: number
  /**
   * Lifetime spend at or above this also makes somebody VIP, minor units.
   * 0 turns the spend route off and leaves VIP purely about visit count.
   */
  vipAfterSpend: number

  /* ── Coming back after a while ───────────────────────────────────────────── */

  /** Days away, at or above which a returning guest gets a welcome back. */
  welcomeBackDays: number
  /** Days away, at or above which it is worth making a fuss of them. */
  longTimeReturnDays: number
}

export const DEFAULT_LIVE_POLICY: LiveBoardPolicy = {
  normalMax: 10,
  watchMax: 15,
  attentionMax: 20,
  delayedMax: 30,

  noFoodServedMin: 20,
  readyNotServedMin: 5,
  stuckPreparingMin: 25,
  paymentPendingMin: 15,
  longServiceMin: 90,
  sensitiveWaitingMin: 15,
  serviceRequestMin: 3,
  lowProgressPct: 50,

  regularAfterVisits: 5,
  vipAfterVisits: 15,
  vipAfterSpend: 0,

  welcomeBackDays: 30,
  longTimeReturnDays: 90,
}

export async function getLiveBoardPolicy(restaurantId: string): Promise<LiveBoardPolicy> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { liveBoardPolicy: true },
  })
  const stored = restaurant?.liveBoardPolicy as Partial<LiveBoardPolicy> | null
  return { ...DEFAULT_LIVE_POLICY, ...(stored ?? {}) }
}
