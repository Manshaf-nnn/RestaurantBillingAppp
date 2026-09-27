import 'server-only'

import { AppError, NotFoundError } from '@/lib/errors'
import { guardLocks, prisma } from '@/server/db/prisma'
import { outstandingOn } from './pricing'

/**
 * Handing a delivery over at the door.
 *
 * ── Why a PIN, and what it is actually protecting ───────────────────────────
 *
 * Every other way food leaves the kitchen happens in front of somebody: a
 * waiter puts the plate on the table, a customer takes the bag off the
 * counter. A delivery is the one case where the person who ordered and the
 * person carrying it have never met, and "delivered" is asserted by the rider
 * alone. The PIN turns that assertion into something the customer took part
 * in — the order is closed by a number only they were shown.
 *
 * It is not an anti-fraud system and does not pretend to be. A rider who
 * throws the food away and asks the customer for the PIN anyway will get it.
 * What it stops is the ordinary failure: a delivery marked done that never
 * arrived, or that went to the wrong door, with nothing afterwards able to
 * tell which.
 *
 * ── How the number stays unknown to the person typing it ────────────────────
 *
 * The desk never receives it. `getDeliveryQueue` selects every column the
 * screen needs and not `deliveryPin`, so it is not in the page, not in the RSC
 * payload and not in any response the rider's browser can be made to show. The
 * only channel is this function, which answers one guess at a time and counts
 * the wrong ones.
 */

/** Wrong guesses before this order stops accepting them at all. */
const MAX_ATTEMPTS = 10

export type HandoverRefusal =
  | 'NOT_A_DELIVERY'
  | 'NOT_READY'
  | 'ALREADY_DONE'
  | 'NO_PIN'
  | 'WRONG_PIN'
  | 'TOO_MANY_ATTEMPTS'

export class HandoverError extends AppError {
  constructor(
    public readonly refusal: HandoverRefusal,
    message: string,
    /** Guesses left, when saying so helps rather than helps an attacker. */
    public readonly attemptsLeft?: number,
  ) {
    super(message, 409, refusal)
  }
}

export interface HandoverResult {
  orderId: string
  orderNumber: string
  deliveredAt: string
  /** Still owed after the handover, so the caller knows whether to collect. */
  outstanding: number
}

/**
 * Check the PIN and close the delivery, or refuse and say why.
 *
 * ── Everything in one transaction, over a locked row ────────────────────────
 *
 * Two riders tapping at once, or one tapping twice on a slow connection, must
 * not produce two completions — and a wrong guess must be counted exactly
 * once. So the row is locked FOR UPDATE before it is read, every decision is
 * made against what the lock returned, and the write happens before anyone
 * else can see the row. `guardLocks` is the house rule for taking one.
 *
 * The status check inside the fence is what makes a duplicate tap safe: the
 * second one finds SERVED and is refused as already done, rather than
 * overwriting who delivered it and when.
 */
/**
 * Is this Postgres telling us two transactions chose each other?
 *
 * Exported for `delivery-retry-test`, which injects a `40P01` rather than
 * trying to provoke a real deadlock — the retry is control flow, and control
 * flow that only runs under a race nobody can reproduce on demand is control
 * flow nothing checks.
 *
 * `40P01` is deadlock_detected. Postgres resolves a deadlock by rolling ONE
 * transaction back whole, so the data is never wrong — but the loser is handed
 * a raw database error, and a rider standing at a door cannot act on
 * "deadlock detected" and cannot tell whether the delivery went through.
 */
export function isDeadlock(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '40P01'
  )
}

/**
 * Run the handover, retrying a deadlock a bounded number of times.
 *
 * ── Why retry here and not everywhere ───────────────────────────────────────
 *
 * A four-way race on one order — a till taking money, a second till taking
 * money, a manager voiding a line, the kitchen changing state — already
 * deadlocks in this system. A delivery being handed over is a FIFTH actor on
 * that same row, and it is the one whose user is standing on somebody's
 * doorstep with the food in their hand.
 *
 * Retrying is right for `40P01` specifically because it is transient by
 * definition: the loser rolled back completely, so a second attempt starts
 * clean and usually wins. It is safe here because the attempt is idempotent in
 * the ways that matter — a retry that finds the order already SERVED refuses
 * as ALREADY_DONE rather than completing twice, and the wrong-PIN counter was
 * rolled back with everything else, so a guess is never counted twice for one
 * tap.
 *
 * Bounded at three and deliberately not a general policy. Making every money
 * path retry, to improve an error message on data that is already correct, is
 * a decision for somebody looking at all of them at once.
 */
export async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await run()
    } catch (error) {
      if (!isDeadlock(error)) throw error
      lastError = error
      // A short, growing pause so two losers do not collide again immediately.
      await new Promise((resolve) => setTimeout(resolve, 40 * (i + 1)))
    }
  }
  throw lastError
}

export async function completeDeliveryWithPin(params: {
  restaurantId: string
  orderId: string
  pin: string
  actorId: string
  actorName: string
  /** Locations this person may act in, or null for unconfined. */
  branchIds: string[] | null
}): Promise<HandoverResult> {
  const outcome = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await guardLocks(tx)

    const locked = await tx.$queryRaw<
      Array<{
        id: string
        orderNumber: string
        type: string
        status: string
        branchId: string
        deliveryPin: string | null
        deliveryPinAttempts: number
        grandTotal: number
        tipAmount: number
        paidTotal: number
      }>
    >`
      SELECT id, "orderNumber", type::text AS type, status::text AS status,
             "branchId", "deliveryPin", "deliveryPinAttempts",
             "grandTotal", "tipAmount", "paidTotal"
        FROM orders
       WHERE id = ${params.orderId} AND "restaurantId" = ${params.restaurantId}
         FOR UPDATE
    `
    const order = locked[0]
    if (!order) throw new NotFoundError('Order')

    /*
     * The branch, checked here rather than before the lock: a person who may
     * not act at this location must not learn from a timing difference whether
     * the PIN they sent was right.
     */
    if (params.branchIds && !params.branchIds.includes(order.branchId)) {
      throw new NotFoundError('Order')
    }

    if (order.type !== 'DELIVERY') {
      throw new HandoverError('NOT_A_DELIVERY', 'That order is not a delivery.')
    }
    if (order.status === 'SERVED' || order.status === 'COMPLETED') {
      throw new HandoverError('ALREADY_DONE', 'That delivery has already been completed.')
    }
    if (order.status !== 'READY') {
      throw new HandoverError(
        'NOT_READY',
        'The kitchen has not marked that order ready yet.',
      )
    }
    if (!order.deliveryPin) {
      /*
       * Placed before PINs existed, or by a route that mints none. It is not
       * completable here — the ordinary status action still is, which is the
       * escape hatch and is permission-gated in its own right.
       */
      throw new HandoverError(
        'NO_PIN',
        'That order has no delivery PIN. A manager can close it from Orders.',
      )
    }
    if (order.deliveryPinAttempts >= MAX_ATTEMPTS) {
      throw new HandoverError(
        'TOO_MANY_ATTEMPTS',
        'Too many wrong PINs on this order. A manager can close it from Orders.',
      )
    }

    if (order.deliveryPin !== params.pin.trim()) {
      /*
       * ── Why the count is returned and not thrown ────────────────────────
       *
       * Incrementing here and throwing in the same breath records nothing:
       * the throw rolls the transaction back, taking the increment with it,
       * and the counter sits at zero however many times anybody guesses. The
       * cap would have been decorative and the test that caught it is the
       * only reason this reads the way it does.
       *
       * So a wrong PIN is a RESULT, not an exception. The transaction commits
       * the count, and the caller raises the refusal afterwards.
       */
      const attempts = order.deliveryPinAttempts + 1
      await tx.order.update({
        where: { id: order.id },
        data: { deliveryPinAttempts: attempts },
      })
      return { wrong: true as const, attemptsLeft: MAX_ATTEMPTS - attempts }
    }

    /*
     * SERVED, not a new DELIVERED status.
     *
     * The tracker already reads SERVED as "Delivered" for a delivery order,
     * the reports speak it, and `ALLOWED_TRANSITIONS` already allows READY →
     * SERVED. Adding a status would mean touching every switch over the enum
     * to say the same thing twice. `servedAt` and `servedById` are the
     * completion time and the person, which is what they have always meant.
     */
    const now = new Date()
    const done = await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'SERVED',
        servedAt: now,
        servedById: params.actorId,
      },
      select: { id: true, orderNumber: true },
    })

    /*
     * The order's own history, the same row every other status change writes.
     * "PIN confirmed" is the part worth keeping: it is the difference between
     * a delivery somebody asserted and one the customer took part in closing.
     */
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        status: 'SERVED',
        note: 'Delivered — PIN confirmed at the door',
        actorId: params.actorId,
        actorName: params.actorName,
      },
    })

    return {
      wrong: false as const,
      result: {
        orderId: done.id,
        orderNumber: done.orderNumber,
        deliveredAt: now.toISOString(),
        /*
         * Read under the same lock that closed the order, so the figure the
         * caller collects against cannot have moved between the two.
         */
        outstanding: outstandingOn(order),
      },
    }
  }))

  /*
   * Raised out here, after the count above has committed. Inside the
   * transaction this throw would have undone the very increment it reports.
   */
  if (outcome.wrong) {
    const left = outcome.attemptsLeft
    throw new HandoverError(
      'WRONG_PIN',
      left > 0
        ? `That PIN does not match. ${left} ${left === 1 ? 'try' : 'tries'} left.`
        : 'That PIN does not match, and this order accepts no more tries.',
      left,
    )
  }
  return outcome.result
}
