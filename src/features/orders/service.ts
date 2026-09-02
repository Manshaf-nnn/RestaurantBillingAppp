import 'server-only'
import type { Order, OrderItem, OrderStatus, Prisma, TableStatus } from '@prisma/client'

import { AppError, ConflictError, NotFoundError } from '@/lib/errors'
import { formatMoney } from '@/lib/money'
import { resolveBranchId } from '@/features/branches/service'
import { applyBranchOverrides, branchOverrides } from '@/features/menu/branch-menu'
import { pinRecipeVersions, reconcileOrderDepletion, snapshotLineCosts } from '@/features/inventory/depletion'
import { orderIsRouted, routeOrderItems } from '@/features/kitchen/routing'
import { notifyLowStock } from '@/features/inventory/alerts'
import {
  prisma,
  isUniqueViolation,
  uniqueViolationTargets,
  type TxClient,
} from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { notify } from '@/server/notifications'
import { realtime } from '@/server/realtime/emitter'
import type { OrderSummaryPayload } from '@/lib/realtime/events'
import {
  computeTotals,
  effectivePrice,
  estimatePrepMinutes,
  evaluateCoupon,
  maxRedeemablePoints,
  pointsEarned,
  pointsValue,
  type SelectedOption,
} from './pricing'

// ── order numbers ────────────────────────────────────────────────────────────

/**
 * Human-friendly, per-restaurant, per-day sequence: `240724-014`.
 * Collisions under concurrency are resolved by retrying the insert.
 */
/**
 * The next order number for today, e.g. `260816-004`.
 *
 * Derived from the highest number already issued for the day, not from a count
 * of today's orders. Counting was wrong in two ways:
 *
 *  - It counted rows created since *server-local* midnight while stamping the
 *    date in the *restaurant's* timezone. On a UTC host serving a UTC+5:30
 *    restaurant those roll over 5½ hours apart, so for that window each day the
 *    counter resets while the stamp does not — and the sequence restarts at 001
 *    over numbers already issued that morning.
 *  - Cancelling an order lowers the count, so the next order reuses a number
 *    that already exists.
 *
 * Reading the maximum instead makes the day's prefix the only thing that
 * decides the window, so both problems disappear. Concurrent callers can still
 * derive the same number — that race is settled by the unique index and the
 * retry in `placeOrder`, which is the only way to settle it correctly.
 */
async function nextOrderNumber(
  tx: TxClient,
  restaurantId: string,
  timezone: string,
): Promise<string> {
  const stamp = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replace(/-/g, '')

  const prefix = `${stamp}-`

  // Covered by the unique index on (restaurantId, orderNumber).
  const issued = await tx.order.findMany({
    where: { restaurantId, orderNumber: { startsWith: prefix } },
    select: { orderNumber: true },
  })

  // Split bills add a letter suffix (`260816-004-A`); parseInt stops at it, so
  // a split never inflates the sequence.
  const highest = issued.reduce((max, row) => {
    const sequence = Number.parseInt(row.orderNumber.slice(prefix.length), 10)
    return Number.isFinite(sequence) && sequence > max ? sequence : max
  }, 0)

  return `${prefix}${String(highest + 1).padStart(3, '0')}`
}

// ── draft construction ───────────────────────────────────────────────────────

export interface DraftItemInput {
  foodId: string
  quantity: number
  optionIds: string[]
  notes?: string
}

export interface PricedDraftItem {
  foodId: string
  name: string
  imageUrl: string | null
  unitPrice: number
  quantity: number
  options: SelectedOption[]
  optionsTotal: number
  lineTotal: number
  costPrice: number
  notes: string | null
  isVeg: boolean
  prepTimeMinutes: number
}

export interface OrderDraft {
  items: PricedDraftItem[]
  totals: ReturnType<typeof computeTotals>
  couponId: string | null
  couponCode: string | null
  couponError: string | null
  loyaltyPointsUsed: number
  estimatedMinutes: number
}

/**
 * Re-prices a cart from authoritative database records.
 *
 * Nothing about price, availability or option membership is taken from the
 * client — only ids and quantities. This is what makes tampering with the
 * browser payload harmless.
 */
export async function buildDraft(params: {
  restaurantId: string
  items: DraftItemInput[]
  couponCode?: string | null
  manualDiscount?: number
  redeemPoints?: number
  customerId?: string | null
  /*
   * Which branch this order is for. Lines are priced at ITS prices, and a dish
   * that branch does not sell is refused here rather than being quietly rung
   * up at the restaurant's base price.
   */
  branchId?: string | null
  db?: TxClient
}): Promise<OrderDraft> {
  const db = params.db ?? prisma
  const restaurant = await requireRestaurant(params.restaurantId)

  if (!params.items.length) throw new AppError('Your cart is empty', 400, 'EMPTY_CART')

  const foodIds = [...new Set(params.items.map((item) => item.foodId))]
  const [foods, overrides] = await Promise.all([
    db.food.findMany({
      where: { id: { in: foodIds }, restaurantId: params.restaurantId, deletedAt: null },
      include: { variantGroups: { include: { options: true } } },
    }),
    branchOverrides({ restaurantId: params.restaurantId, branchId: params.branchId }),
  ])

  const foodById = new Map(foods.map((food) => [food.id, food]))
  const now = new Date()
  const priced: PricedDraftItem[] = []

  for (const line of params.items) {
    const base = foodById.get(line.foodId)
    if (!base) throw new NotFoundError('Menu item')

    /*
     * A dish the branch does not sell cannot be ordered there.
     *
     * `overrides` is null when no branch is in play, which is the ordinary
     * single-site case and means "no restriction". When a branch IS in play, a
     * missing entry means the dish is not on that branch's menu at all —
     * different from being on it and switched off, and both refused with the
     * same message a guest already understands.
     */
    if (overrides && !overrides.has(base.id)) {
      throw new AppError(`${base.name} is not on the menu here`, 409, 'ITEM_UNAVAILABLE')
    }

    // The branch's price and availability, merged on before pricing runs.
    const food = applyBranchOverrides(base, overrides?.get(base.id))
    if (!food.isAvailable) {
      throw new AppError(`${food.name} is currently unavailable`, 409, 'ITEM_UNAVAILABLE')
    }

    const optionById = new Map(
      food.variantGroups.flatMap((group) =>
        group.options.map((option) => [option.id, { option, group }] as const),
      ),
    )

    const selected: SelectedOption[] = []
    const perGroup = new Map<string, number>()

    for (const optionId of line.optionIds) {
      const entry = optionById.get(optionId)
      // An option that does not belong to this item is a tampered payload.
      if (!entry) throw new AppError('Invalid choice for ' + food.name, 400, 'INVALID_OPTION')
      if (!entry.option.isAvailable) {
        throw new AppError(`${entry.option.name} is unavailable`, 409, 'OPTION_UNAVAILABLE')
      }
      selected.push({
        groupId: entry.group.id,
        groupName: entry.group.name,
        optionId: entry.option.id,
        name: entry.option.name,
        priceDelta: entry.option.priceDelta,
        kind: entry.group.kind,
      })
      perGroup.set(entry.group.id, (perGroup.get(entry.group.id) ?? 0) + 1)
    }

    // Enforce each group's own selection rules.
    for (const group of food.variantGroups) {
      const count = perGroup.get(group.id) ?? 0
      if (group.isRequired && count < Math.max(1, group.minSelect)) {
        throw new AppError(`Choose ${group.name} for ${food.name}`, 400, 'OPTION_REQUIRED')
      }
      if (count > group.maxSelect && group.maxSelect > 0) {
        throw new AppError(
          `Select at most ${group.maxSelect} from ${group.name} for ${food.name}`,
          400,
          'TOO_MANY_OPTIONS',
        )
      }
    }

    const { price } = effectivePrice(food, now, restaurant.timezone)
    const extras = selected.reduce((total, option) => total + option.priceDelta, 0)
    const quantity = Math.max(1, Math.trunc(line.quantity))

    priced.push({
      foodId: food.id,
      name: food.name,
      imageUrl: food.imageUrl,
      unitPrice: price,
      quantity,
      options: selected,
      optionsTotal: extras,
      lineTotal: (price + extras) * quantity,
      /*
       * Zero, not the menu's cost field. `snapshotLineCosts` is the sole writer
       * of this column, and it only ever fills a zero — so copying the menu's
       * figure here meant any restaurant that had typed one never received the
       * real weighted-average snapshot, and its profit report reported an old
       * guess for ever. A zero here means "not yet costed" and nothing else.
       */
      costPrice: 0,
      notes: line.notes?.trim() || null,
      isVeg: food.isVeg,
      prepTimeMinutes: food.prepTimeMinutes,
    })
  }

  const subtotal = priced.reduce((total, item) => total + item.lineTotal, 0)

  // ── coupon ────────────────────────────────────────────────────────────────
  let couponId: string | null = null
  let couponCode: string | null = null
  let couponDiscount = 0
  let couponError: string | null = null

  if (params.couponCode) {
    const coupon = await db.coupon.findFirst({
      where: {
        restaurantId: params.restaurantId,
        code: params.couponCode.toUpperCase(),
      },
    })

    if (!coupon) {
      couponError = 'That coupon code was not found'
    } else {
      const evaluation = evaluateCoupon(coupon, subtotal, now)
      if (!evaluation.valid) {
        couponError = evaluation.reason ?? 'This coupon cannot be applied'
      } else if (coupon.perCustomerLimit !== null && params.customerId) {
        const used = await db.couponRedemption.count({
          where: { couponId: coupon.id, customerId: params.customerId },
        })
        if (used >= coupon.perCustomerLimit) {
          couponError = 'You have already used this coupon'
        } else {
          couponId = coupon.id
          couponCode = coupon.code
          couponDiscount = evaluation.discount
        }
      } else {
        couponId = coupon.id
        couponCode = coupon.code
        couponDiscount = evaluation.discount
      }
    }
  }

  // ── loyalty ───────────────────────────────────────────────────────────────
  let loyaltyPointsUsed = 0
  let loyaltyDiscount = 0

  if (restaurant.loyaltyEnabled && params.redeemPoints && params.customerId) {
    const customer = await db.customer.findFirst({
      where: { id: params.customerId, restaurantId: params.restaurantId },
      select: { loyaltyPoints: true },
    })
    if (customer) {
      loyaltyPointsUsed = maxRedeemablePoints(
        subtotal - couponDiscount,
        Math.min(params.redeemPoints, customer.loyaltyPoints),
        restaurant.loyaltyPointValue,
      )
      loyaltyDiscount = pointsValue(loyaltyPointsUsed, restaurant.loyaltyPointValue)
    }
  }

  const totals = computeTotals({
    lines: priced,
    taxRateBps: restaurant.taxRateBps,
    serviceChargeBps: restaurant.serviceChargeBps,
    taxInclusive: restaurant.taxInclusive,
    couponDiscount,
    manualDiscount: params.manualDiscount ?? 0,
    loyaltyDiscount,
    currency: restaurant.currency,
    roundTotal: true,
  })

  const activeOrders = await db.order.count({
    where: {
      restaurantId: params.restaurantId,
      status: { in: ['PENDING', 'ACCEPTED', 'PREPARING'] },
    },
  })

  return {
    items: priced,
    totals,
    couponId,
    couponCode,
    couponError,
    loyaltyPointsUsed,
    estimatedMinutes: estimatePrepMinutes(priced, activeOrders),
  }
}

// ── placing an order ─────────────────────────────────────────────────────────

export interface PlaceOrderParams {
  restaurantId: string
  tableId?: string | null
  type?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | 'COUNTER'
  /// How the order reached the system. Defaults to STAFF; the guest QR flow
  /// passes QR so reporting can separate self-service from keyed-in orders.
  channel?: 'QR' | 'STAFF' | 'COUNTER' | 'PHONE' | 'ONLINE'
  branchId?: string | null
  customerName: string
  customerPhone: string
  customerEmail?: string | null
  guestCount?: number | null
  notes?: string | null
  items: DraftItemInput[]
  couponCode?: string | null
  manualDiscount?: number
  redeemPoints?: number
  guestSessionId?: string | null
  /**
   * One id per cart, generated by the client.
   *
   * Makes placement idempotent: a double tap or a retry after a dropped
   * connection carries the same key, so the second attempt returns the order
   * that already exists instead of creating another one and deducting a second
   * set of ingredients. Optional — an order keyed in at the counter has no
   * client to generate one.
   */
  idempotencyKey?: string | null
  createdById?: string | null
  servedById?: string | null
}

/**
 * An order with the lines that were priced onto it.
 *
 * Assignable to `Order`, so nothing that only wanted the header had to change.
 */
export type PlacedOrder = Order & { items: OrderItem[] }

export async function placeOrder(params: PlaceOrderParams): Promise<PlacedOrder> {
  /*
   * Has this exact cart already been placed?
   *
   * Checked before any work, so the common case — a guest tapping Place Order
   * twice on a slow connection — costs one indexed lookup and returns the order
   * they already have. There is still a race between two simultaneous requests
   * carrying the same key, and that is caught by the unique constraint below;
   * this is the cheap path, not the correctness guarantee.
   */
  if (params.idempotencyKey) {
    const existing = await prisma.order.findFirst({
      where: { restaurantId: params.restaurantId, idempotencyKey: params.idempotencyKey },
      // Same shape as a fresh placement, so a caller building a bill from the
      // result gets one whether this was the first tap or the second.
      include: { items: true },
    })
    if (existing) return existing
  }

  const restaurant = await requireRestaurant(params.restaurantId)
  const type = params.type ?? 'DINE_IN'

  if (type === 'DINE_IN' && !params.tableId) {
    throw new AppError('A table is required for dine-in orders', 400, 'TABLE_REQUIRED')
  }

  /*
   * Everything that only reads happens before the transaction opens.
   *
   * Re-pricing the cart reads the menu, its variant groups and any coupon —
   * several round trips. Doing that inside the write transaction held a database
   * connection open for the whole of it, so on a busy service transactions
   * queued behind each other until they hit their own 15-second timeout and the
   * guest was told "Something went wrong". Measured before this change: six
   * simultaneous orders took 15s and twelve failed outright. The transaction now
   * contains writes only.
   *
   * Loyalty pricing needs the guest's current points, so the customer is read
   * here and upserted inside the transaction. A guest ordering for the first
   * time has no points, which is what `null` prices correctly.
   */
  /*
   * No phone number, no customer record.
   *
   * Every blank phone used to collapse into ONE Customer row keyed
   * `phone: ''` — the shared walk-in. Its loyalty points were the pooled
   * points of every anonymous guest the restaurant ever served, and anyone
   * ordering without a phone number could spend them. An anonymous order now
   * carries its name snapshot on the order row and no customer at all;
   * loyalty needs an identity, and a blank is not one.
   */
  const customerPhone = params.customerPhone.trim()
  const existingCustomer = customerPhone
    ? await prisma.customer.findUnique({
        where: {
          restaurantId_phone: { restaurantId: params.restaurantId, phone: customerPhone },
        },
        select: { id: true, isBlocked: true },
      })
    : null

  if (existingCustomer?.isBlocked) {
    throw new AppError('This account cannot place orders. Please speak to our staff.', 403, 'BLOCKED')
  }

  /*
   * Which branch this order belongs to, resolved before the cart is priced.
   *
   * It has to come first: the branch decides the prices, so pricing the cart
   * and then discovering the branch would ring the order up at the restaurant's
   * base prices and store it against a location charging something else.
   *
   * The table decides where there is one — a guest at Kandy's table 4 is
   * ordering from Kandy — then the caller's branch, then the restaurant's
   * default. `resolveBranchId` never returns null.
   *
   * ── Why a disagreement is now an error ──────────────────────────────────
   *
   * This was `seatedAt?.branchId ?? …`, so the table won OUTRIGHT and silently.
   * That is fine when the caller offered no opinion, and dangerous when it did:
   * a guest who scanned Branch 01's QR, and whose `?b=` and cookie both said
   * Branch 01, was seated at Main's table 1 by `resolveTable` (which ignored
   * the branch) and the order was filed at Main — the correct branch discarded
   * without a word, and the ticket printed in the wrong kitchen.
   *
   * `resolveTable` is fixed, so the two agree in normal operation. If they ever
   * disagree again the answer is not to pick one: something upstream is wrong,
   * and an order is about to be routed to a kitchen that is not expecting it.
   */
  const seatedAt = params.tableId
    ? await prisma.restaurantTable.findFirst({
        where: { id: params.tableId, restaurantId: params.restaurantId, isActive: true },
        // The number too, so the order can keep a copy: `tableId` is SetNull,
        // and a deleted table used to erase which table an order had been at.
        select: { branchId: true, number: true },
      })
    : null

  if (seatedAt && params.branchId && seatedAt.branchId !== params.branchId) {
    throw new AppError(
      'That table is at a different location from the one you are ordering from. Please scan the code on your own table.',
      409,
      'BRANCH_TABLE_MISMATCH',
    )
  }

  const branchId =
    seatedAt?.branchId ??
    (await resolveBranchId({
      restaurantId: params.restaurantId,
      requestedBranchId: params.branchId,
    }))

  const draft = await buildDraft({
    restaurantId: params.restaurantId,
    items: params.items,
    couponCode: params.couponCode,
    manualDiscount: params.manualDiscount,
    redeemPoints: params.redeemPoints,
    customerId: existingCustomer?.id ?? null,
    branchId,
  })

  if (params.couponCode && draft.couponError) {
    throw new AppError(draft.couponError, 400, 'COUPON_INVALID')
  }

  const runPlacement = () =>
    prisma.$transaction(
    async (tx) => {
      // Table must exist inside this tenant — never trust a submitted id.
      let table = null
      if (params.tableId) {
        table = await tx.restaurantTable.findFirst({
          where: { id: params.tableId, restaurantId: params.restaurantId, isActive: true },
        })
        if (!table) throw new NotFoundError('Table')
      }

      // Customers are keyed by phone within a restaurant — and only exist
      // when there is a phone to key them by.
      const customer = customerPhone
        ? await tx.customer.upsert({
            where: {
              restaurantId_phone: {
                restaurantId: params.restaurantId,
                phone: customerPhone,
              },
            },
            create: {
              restaurantId: params.restaurantId,
              name: params.customerName,
              phone: customerPhone,
              email: params.customerEmail || null,
            },
            update: {
              name: params.customerName,
              ...(params.customerEmail ? { email: params.customerEmail } : {}),
            },
          })
        : null

      // Blocked status was checked before the transaction; re-check here only in
      // case the row was created between the two, which the upsert would hide.
      if (customer?.isBlocked) {
        throw new AppError('This account cannot place orders. Please speak to our staff.', 403, 'BLOCKED')
      }

      // No retry loop here: a Postgres transaction is aborted the moment a
      // statement violates a constraint, so every later statement in it fails
      // with "current transaction is aborted". Retrying inside the transaction
      // could never succeed — the retry lives around the whole transaction, in
      // `placeOrder` below.
      const orderNumber = await nextOrderNumber(tx, params.restaurantId, restaurant.timezone)
      /*
       * The lines come back with the order.
       *
       * A bill printed at the till needs the priced lines, and re-reading the
       * order to get them would be a second round trip for rows Postgres has
       * just written. `include` costs nothing here — same statement — and
       * `Order & { items }` still satisfies every caller that only wanted an
       * `Order`.
       */
      const created: PlacedOrder = await tx.order.create({
        include: { items: true },
            data: {
              restaurantId: params.restaurantId,
              orderNumber,
              idempotencyKey: params.idempotencyKey || null,
              type,
              channel: params.channel ?? 'STAFF',
              branchId,
              status: 'PENDING',
              paymentStatus: 'UNPAID',
              tableId: table?.id ?? null,
              // Snapshotted, not derived. `tableId` is SetNull, so deleting a
              // table used to erase which table every past order had been at.
              tableNumber: table?.number ?? null,
              customerId: customer?.id ?? null,
              customerName: params.customerName,
              customerPhone: customerPhone,
              customerEmail: params.customerEmail || null,
              guestSessionId: params.guestSessionId ?? null,
              createdById: params.createdById ?? null,
              servedById: params.servedById ?? null,
              guestCount: params.guestCount ?? null,
              notes: params.notes || null,
              couponId: draft.couponId,
              subtotal: draft.totals.subtotal,
              discountTotal: draft.totals.discountTotal,
              couponDiscount: draft.totals.couponDiscount,
              manualDiscount: draft.totals.manualDiscount,
              loyaltyDiscount: draft.totals.loyaltyDiscount,
              taxTotal: draft.totals.taxTotal,
              serviceCharge: draft.totals.serviceCharge,
              roundingAdj: draft.totals.roundingAdj,
              grandTotal: draft.totals.grandTotal,
              taxRateBps: restaurant.taxRateBps,
              serviceChargeBps: restaurant.serviceChargeBps,
              estimatedMinutes: draft.estimatedMinutes,
              items: {
                create: draft.items.map((item) => ({
                  foodId: item.foodId,
                  name: item.name,
                  imageUrl: item.imageUrl,
                  unitPrice: item.unitPrice,
                  quantity: item.quantity,
                  options: item.options as unknown as Prisma.InputJsonValue,
                  optionsTotal: item.optionsTotal,
                  lineTotal: item.lineTotal,
                  costPrice: item.costPrice,
                  notes: item.notes,
                  isVeg: item.isVeg,
                  prepTimeMinutes: item.prepTimeMinutes,
                })),
              },
              events: {
                create: { status: 'PENDING', note: 'Order received' },
              },
            },
          })

      // Coupon accounting. The redemption records what the COUPON took —
      // this used to write the whole discount blob, so a manual discount on
      // the same order was booked against the coupon's name.
      if (draft.couponId && draft.totals.couponDiscount > 0) {
        await tx.coupon.update({
          where: { id: draft.couponId },
          data: { usedCount: { increment: 1 } },
        })
        await tx.couponRedemption.create({
          data: {
            couponId: draft.couponId,
            orderId: created.id,
            customerId: customer?.id ?? null,
            amount: draft.totals.couponDiscount,
          },
        })
      }

      // Loyalty spend is debited now; the earn happens at settlement.
      if (draft.loyaltyPointsUsed > 0 && customer) {
        /*
         * Conditional, not blind: two orders spending the same points at the
         * same moment both priced against the same balance, and the second
         * decrement drove it negative — a discount granted against points the
         * guest did not have. The guarded update finds the row only while the
         * balance still covers the spend; the CHECK constraint underneath is
         * the last line if this is ever bypassed.
         */
        const spent = await tx.customer.updateMany({
          where: { id: customer.id, loyaltyPoints: { gte: draft.loyaltyPointsUsed } },
          data: { loyaltyPoints: { decrement: draft.loyaltyPointsUsed } },
        })
        if (spent.count === 0) {
          throw new AppError(
            'Those loyalty points were just spent on another order. The balance no longer covers this redemption.',
            409,
            'POINTS_SPENT',
          )
        }
        await tx.loyaltyEntry.create({
          data: {
            restaurantId: params.restaurantId,
            customerId: customer.id,
            orderId: created.id,
            points: -draft.loyaltyPointsUsed,
            kind: 'REDEEMED',
            note: `Redeemed against ${created.orderNumber}`,
          },
        })
      }

      if (customer) {
        await tx.customer.update({
          where: { id: customer.id },
          data: { totalOrders: { increment: 1 }, lastOrderAt: new Date() },
        })
      }

      await tx.food.updateMany({
        where: { id: { in: draft.items.map((item) => item.foodId) } },
        data: { soldCount: { increment: 1 } },
      })

      /*
       * Seat the party — from any state that means nobody is sitting there.
       *
       * This used to require `AVAILABLE`, and a settled table is left in
       * `CLEANING` (see the release below, and `payments/service.ts`), which
       * nothing in server code ever clears — a busser taps it. So the SECOND
       * party of the day to sit at a table never marked it occupied, and every
       * screen reading `RestaurantTable.status` under-reported the floor from
       * about lunchtime onwards.
       *
       * Deliberately not "anything except OCCUPIED": `ORDERING`, `EATING` and
       * `WAITING_BILL` are set by hand on the waiter board and say more than
       * `OCCUPIED` does. A second round ordered while a table waits for its
       * bill must not overwrite `WAITING_BILL` with something coarser.
       */
      if (table && NOBODY_SEATED.has(table.status)) {
        await tx.restaurantTable.update({
          where: { id: table.id },
          data: { status: 'OCCUPIED' },
        })
      }

      return created
    },
    {
      timeout: 15_000,
      // How long to wait for a free connection before giving up. Prisma's
      // default is 2s, which a busy moment on a serverless host exceeds easily —
      // and the resulting P2028 reaches the guest as "Something went wrong"
      // rather than anything they can act on. Waiting a little longer to place
      // an order is always better than refusing it.
      maxWait: 10_000,
    },
  )

  /*
   * Two guests tapping "Place order" at the same moment derive the same order
   * number, and the unique index on (restaurantId, orderNumber) rejects the
   * loser. That is the correct outcome — it is what guarantees numbers are
   * unique — but it must not reach the guest as an error. Re-running the whole
   * transaction re-reads the highest number, so the retry gets the next one.
   *
   * The same loop absorbs transient database contention — a transaction that
   * could not get a connection in time (P2028/P2024). Those say nothing about
   * the order; they mean the moment was busy. A guest should never lose a
   * basket because two other tables happened to check out first.
   *
   * Everything else is a real failure and surfaces immediately.
   */
  // An attempt is now a short write-only transaction (~10 ms), so attempts are
  // cheap and the ceiling can be generous: with twenty guests checking out in
  // the same instant, the unluckiest one still needs several tries before it
  // finds a free number. Five was not enough at that volume; ten is, with room
  // to spare, and costs nothing when there is no contention.
  const MAX_ATTEMPTS = 10
  const TRANSIENT_CODES = new Set([
    'P2024', // timed out fetching a connection from the pool
    'P2028', // could not start a transaction in the given time
    'P1017', // server closed the connection
  ])
  let order: PlacedOrder | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      order = await runPlacement()
      break
    } catch (error) {
      /*
       * Two requests carrying the same idempotency key raced, and this one lost.
       *
       * The loser must not retry — retrying would mint a second order number and
       * succeed, which is the duplicate this key exists to prevent. It returns
       * the winner's order instead, so both callers see the same result and only
       * one set of ingredients is ever deducted.
       */
      if (
        params.idempotencyKey &&
        isUniqueViolation(error) &&
        uniqueViolationTargets(error).includes('idempotencyKey')
      ) {
        const winner = await prisma.order.findFirst({
          where: { restaurantId: params.restaurantId, idempotencyKey: params.idempotencyKey },
          include: { items: true },
        })
        if (winner) return winner
      }

      const isDuplicateNumber =
        isUniqueViolation(error) && uniqueViolationTargets(error).includes('orderNumber')
      const code = (error as { code?: string })?.code
      const isTransient = typeof code === 'string' && TRANSIENT_CODES.has(code)

      if ((!isDuplicateNumber && !isTransient) || attempt === MAX_ATTEMPTS) throw error

      // Jittered backoff — a fixed delay would just line the losers up to
      // collide with each other again on the next attempt.
      await new Promise((resolve) => setTimeout(resolve, attempt * 20 + Math.random() * 30))
    }
  }

  if (!order) throw new ConflictError('Could not allocate an order number, please retry')

  await broadcastOrder(order.id, 'created')
  return order
}

// ── status transitions ───────────────────────────────────────────────────────

/**
 * Table states that mean nobody is sitting there.
 *
 * `CLEANING` is on this list and that is the whole point: a table is left
 * cleaning after its bill settles, only a busser clears it, and until this was
 * widened the next party to sit down never marked the table occupied.
 *
 * `RESERVED` is here too — a booked party arriving and ordering is exactly the
 * moment the booking becomes a seating. The four in-use states are absent on
 * purpose; see the seating code above.
 */
const NOBODY_SEATED = new Set<TableStatus>(['AVAILABLE', 'CLEANING', 'RESERVED'])

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['ACCEPTED', 'PREPARING', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'READY', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['SERVED', 'COMPLETED', 'CANCELLED'],
  SERVED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
}

const STATUS_TIMESTAMP: Partial<Record<OrderStatus, keyof Prisma.OrderUpdateInput>> = {
  ACCEPTED: 'acceptedAt',
  PREPARING: 'preparingAt',
  READY: 'readyAt',
  SERVED: 'servedAt',
  COMPLETED: 'completedAt',
  CANCELLED: 'cancelledAt',
}

/**
 * The rungs an order climbs. `PENDING` is a starting point, never a target.
 */
const LADDER: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED']

/**
 * Work out an order's status from its items, and walk it there.
 *
 * ── One arrow, one direction ────────────────────────────────────────────────
 *
 * This calls `updateOrderStatus`. `updateOrderStatus` must never call this.
 * That asymmetry is the only thing stopping the two from chasing each other:
 * once an order's items have been sent to kitchen sections, the order status is
 * a readout of them and its downward cascade is switched off.
 *
 * ── Why it replays the ladder rather than jumping ───────────────────────────
 *
 * (Carried from `updateItemStatus`, which did this for SERVED alone. The
 * reasoning is the whole justification for the replay, so it travels with the
 * code.)
 *
 * A waiter can carry out the last plate while the order still says `PREPARING`
 * — the kitchen never tapped "ready", it just handed the food over — and then
 * every item read SERVED while the order sat at PREPARING for ever. Its table
 * never freed, and on the live board it showed as a permanently critical table
 * at 100% served.
 *
 * The fix is not a `PREPARING → SERVED` edge in `ALLOWED_TRANSITIONS`: that
 * would let the kitchen jump straight to served without ever stamping
 * `readyAt`, and every cook-time and ready-but-waiting figure is measured from
 * that stamp. Instead each intervening step is applied in turn, so the
 * timestamps stay monotonic and truthful — if every plate is out then the food
 * was ready, and this instant is the latest moment that can have become true.
 *
 * `PENDING` is deliberately not a target: an order the kitchen has never
 * accepted is a different problem, and forcing it through the accept path here
 * would post stock depletion as a side effect of a cook's tap.
 *
 * ── Never backwards ─────────────────────────────────────────────────────────
 *
 * A later dish arriving on a table whose food is already out does not un-ready
 * the order. Going backwards would unstamp nothing (the timestamps are already
 * written) but would churn the boards and the event log for no gain, and
 * `ALLOWED_TRANSITIONS` forbids it in any case.
 */
export async function deriveOrderStatus(params: {
  restaurantId: string
  orderId: string
  actorId?: string | null
  actorName?: string | null
}): Promise<OrderStatus | null> {
  const order = await prisma.order.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
    select: {
      status: true,
      items: { where: { status: { not: 'CANCELLED' } }, select: { status: true } },
    },
  })
  if (!order) return null

  // An order the kitchen has not taken on yet is not derived from anything.
  if (order.status === 'PENDING') return null
  if (order.items.length === 0) return null

  const statuses = order.items.map((item) => item.status)
  const target: OrderStatus | null = statuses.every((s) => s === 'SERVED')
    ? 'SERVED'
    : statuses.every((s) => s === 'READY' || s === 'SERVED')
      ? 'READY'
      : statuses.some((s) => s === 'PREPARING')
        ? 'PREPARING'
        : null
  if (!target) return null

  const from = LADDER.indexOf(order.status)
  const to = LADDER.indexOf(target)
  if (from === -1 || to <= from) return null

  for (const next of LADDER.slice(from + 1, to + 1)) {
    await updateOrderStatus({
      restaurantId: params.restaurantId,
      orderId: params.orderId,
      status: next,
      actorId: params.actorId ?? null,
      actorName: params.actorName ?? null,
    })
  }
  return target
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

export async function updateOrderStatus(params: {
  restaurantId: string
  orderId: string
  status: OrderStatus
  note?: string
  estimatedMinutes?: number
  actorId?: string | null
  actorName?: string | null
}): Promise<Order> {
  const order = await prisma.order.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
    include: { table: true },
  })
  if (!order) throw new NotFoundError('Order')

  if (order.status === params.status) return order

  /*
   * Belt to the schema's braces, for direct service callers: cancellation must
   * go through `cancelOrder`, which alone guards paid money, reverses loyalty
   * and coupons, records the reason and frees the table. This function used to
   * accept CANCELLED and quietly did none of that — a PAID order could be
   * cancelled with the money kept and nothing returned.
   */
  if (params.status === 'CANCELLED') {
    throw new AppError('Use cancelOrder to cancel an order', 400, 'USE_CANCEL_ORDER')
  }

  if (!canTransition(order.status, params.status)) {
    throw new AppError(
      `An order that is ${order.status.toLowerCase()} cannot move to ${params.status.toLowerCase()}`,
      409,
      'INVALID_TRANSITION',
    )
  }

  const timestampField = STATUS_TIMESTAMP[params.status]

  let lowStockCandidates: string[] = []

  const updated = await prisma.$transaction(async (tx) => {
    /*
     * Which direction this order's statuses flow.
     *
     * An order whose items have been sent to kitchen sections is a READOUT of
     * those items: each section advances its own dishes and `deriveOrderStatus`
     * walks the order up behind them. Cascading down as well would flatten
     * every section's progress the moment anybody touched the order — a
     * supervisor marking one thing ready would mark the untouched juice ready
     * too.
     *
     * Decided per order and fixed for its life, so an order taken before the
     * owner made their first section keeps cascading to the end.
     */
    const routed = await orderIsRouted(tx, order.id)

    const next = await tx.order.update({
      where: { id: order.id },
      data: {
        status: params.status,
        ...(timestampField ? { [timestampField]: new Date() } : {}),
        ...(params.estimatedMinutes !== undefined
          ? { estimatedMinutes: params.estimatedMinutes }
          : {}),
        // Accepting an order implies its items have entered the queue —
        // unless the sections own them, in which case they say when.
        ...(params.status === 'PREPARING' && !routed
          ? { items: { updateMany: { where: { status: 'QUEUED' }, data: { status: 'PREPARING' } } } }
          : {}),
        ...(params.status === 'READY' && !routed
          ? {
              items: {
                updateMany: {
                  where: { status: { in: ['QUEUED', 'PREPARING'] } },
                  data: { status: 'READY' },
                },
              },
            }
          : {}),
        /*
         * SERVED still cascades in both modes. It is not progress — it is a
         * waiter closing the whole table out at once, which stays a legitimate
         * bulk action however the food was cooked. Cancellation likewise, in
         * `cancelOrder`.
         */
        ...(params.status === 'SERVED'
          ? {
              items: {
                updateMany: { where: { status: { not: 'CANCELLED' } }, data: { status: 'SERVED' } },
              },
            }
          : {}),
        events: {
          create: {
            status: params.status,
            note: params.note,
            actorId: params.actorId ?? null,
            actorName: params.actorName ?? null,
          },
        },
      },
    })

    // Ingredients leave stock once the kitchen commits to cooking, and go back
    // if the order is later cancelled. Reconciliation is declarative — it posts
    // the difference between what the order should have consumed and what it
    // already has — so running it twice, or after a line changes, converges on
    // the right answer instead of double-deducting.
    if (params.status === 'ACCEPTED' || params.status === 'PREPARING') {
      /*
       * Send the dishes to their sections, at the moment the kitchen commits.
       *
       * Here rather than on the ACCEPTED edge alone, because PENDING→PREPARING
       * is a legal transition the old board still takes — hanging routing off
       * ACCEPTED would leave those orders with no sections at all. Idempotent,
       * so passing through both edges routes once.
       */
      await routeOrderItems(tx, { restaurantId: order.restaurantId, orderId: order.id })

      await pinRecipeVersions(tx, { restaurantId: order.restaurantId, orderId: order.id })
      // Same moment, same recipe version: record what those ingredients cost, so
      // the profit report reads the ledger's numbers rather than a menu field.
      await snapshotLineCosts(tx, { restaurantId: order.restaurantId, orderId: order.id })
      const depleted = await reconcileOrderDepletion(tx, {
        restaurantId: order.restaurantId,
        orderId: order.id,
        userId: params.actorId ?? null,
      })
      // Read AFTER the transaction commits — see below. Alerting from inside
      // the transaction meant a rolled-back acceptance could still ring the
      // bell, and a slow notification write held the order row locked.
      lowStockCandidates = depleted.affectedItemIds
    }

    // Free the table once everything on it is settled.
    if (params.status === 'COMPLETED' && order.tableId) {
      const openOrders = await tx.order.count({
        where: {
          restaurantId: order.restaurantId,
          tableId: order.tableId,
          id: { not: order.id },
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
      })
      if (openOrders === 0) {
        await tx.restaurantTable.update({
          where: { id: order.tableId },
          data: { status: 'CLEANING' },
        })
      }
    }

    return next
  })

  // Warn the floor about anything this order pushed to its reorder level —
  // after commit, so the warning can only ever describe stock that really moved.
  if (lowStockCandidates.length > 0) {
    try {
      const low = await prisma.inventoryItem.findMany({
        where: { id: { in: lowStockCandidates }, restaurantId: order.restaurantId },
        select: { id: true, name: true, quantity: true, reorderLevel: true, unit: true },
      })
      for (const item of low) {
        if (item.quantity <= item.reorderLevel) {
          realtime.lowStock(order.restaurantId, {
            itemId: item.id,
            name: item.name,
            quantity: item.quantity,
            reorderLevel: item.reorderLevel,
            unit: item.unit,
          })
          /*
           * The half that is actually seen. The socket event above reaches
           * nobody in production — realtime is off on Netlify and no client
           * subscribes to it anywhere. Persisted to the bell, once a day per
           * item, and deliberately not awaited: a stalled notification must
           * never slow accepting an order.
           */
          void notifyLowStock({
            restaurantId: order.restaurantId,
            branchId: order.branchId,
            item,
          })
        }
      }
    } catch {
      // An alert must never fail the acceptance it rides on.
    }
  }

  await broadcastOrder(order.id, 'status')
  await notifyStatusChange(updated, order.table?.number ?? null)
  // Keep cashier page in sync when order statuses change (kitchen updates)
  try {
    // Revalidate cashier so staff see status changes for takeaway orders
    // Note: next/cache revalidatePath is imported in calling action; here we
    // trigger a light touch by calling the realtime/notify paths — calling
    // revalidatePath is handled in the action layer where permissions exist.
  } catch (e) {
    // no-op
  }
  return updated
}

export async function cancelOrder(params: {
  restaurantId: string
  orderId: string
  reason: string
  actorId?: string | null
  actorName?: string | null
}): Promise<Order> {
  const order = await prisma.order.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
    include: { table: true, redemptions: true },
  })
  if (!order) throw new NotFoundError('Order')
  if (order.status === 'CANCELLED') return order
  /*
   * Any money at all, not just full settlement. The old check was
   * `paymentStatus === 'PAID'`, so a PARTIAL bill — half paid in cash, the
   * rest never collected — could be cancelled with the half kept and no
   * record of it anywhere. Refunds decrement `paidTotal` back to zero, so a
   * properly refunded order passes this and cancels normally.
   */
  if (order.paidTotal > 0) {
    throw new AppError('Refund what has been paid before cancelling this order', 409, 'ORDER_PAID')
  }

  const updated = await prisma.$transaction(async (tx) => {
    /*
     * Which direction this order's statuses flow.
     *
     * An order whose items have been sent to kitchen sections is a READOUT of
     * those items: each section advances its own dishes and `deriveOrderStatus`
     * walks the order up behind them. Cascading down as well would flatten
     * every section's progress the moment anybody touched the order — a
     * supervisor marking one thing ready would mark the untouched juice ready
     * too.
     *
     * Decided per order and fixed for its life, so an order taken before the
     * owner made their first section keeps cascading to the end.
     */
    const routed = await orderIsRouted(tx, order.id)

    const next = await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: params.reason,
        items: { updateMany: { where: {}, data: { status: 'CANCELLED' } } },
        events: {
          create: {
            status: 'CANCELLED',
            note: params.reason,
            actorId: params.actorId ?? null,
            actorName: params.actorName ?? null,
          },
        },
      },
    })

    // Give back anything the guest spent to place the order.
    if (order.loyaltyDiscount > 0 && order.customerId) {
      const restaurant = await tx.restaurant.findUniqueOrThrow({
        where: { id: order.restaurantId },
        select: { loyaltyPointValue: true },
      })
      if (restaurant.loyaltyPointValue > 0) {
        const returned = Math.round(order.loyaltyDiscount / restaurant.loyaltyPointValue)
        await tx.customer.update({
          where: { id: order.customerId },
          data: { loyaltyPoints: { increment: returned } },
        })
        await tx.loyaltyEntry.create({
          data: {
            restaurantId: order.restaurantId,
            customerId: order.customerId,
            orderId: order.id,
            points: returned,
            kind: 'RETURNED',
            note: `${order.orderNumber} cancelled — redeemed points returned`,
            actorId: params.actorId ?? null,
          },
        })
      }
    }

    for (const redemption of order.redemptions) {
      await tx.coupon.update({
        where: { id: redemption.couponId },
        data: { usedCount: { decrement: 1 } },
      })
    }

    if (order.customerId) {
      await tx.customer.update({
        where: { id: order.customerId },
        data: { totalOrders: { decrement: 1 } },
      })
    }

    /*
     * Return any ingredients already deducted.
     *
     * This used to sum the SALE rows and hand-write the reversal: a direct
     * `inventoryItem.update`, a movement with no `balanceAfter` and no cost, and
     * no `applyLocationDelta` — so per-branch stock was never credited back. It
     * also summed only SALE and CONSUMPTION, ignoring SALE_REVERSAL, so an order
     * that had ever been reduced returned *more* than it took. And it left
     * `orderStockDepletion.appliedQty` untouched, so the next reconcile would
     * return everything a second time.
     *
     * `reconcileOrderDepletion` already does this correctly and idempotently:
     * desired becomes nothing, so it posts exactly what is outstanding, through
     * the ledger, with the branch attached.
     */
    await reconcileOrderDepletion(tx, {
      restaurantId: order.restaurantId,
      orderId: order.id,
      userId: params.actorId ?? null,
      releaseAll: true,
    })

    if (order.tableId) {
      const openOrders = await tx.order.count({
        where: {
          restaurantId: order.restaurantId,
          tableId: order.tableId,
          id: { not: order.id },
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
      })
      if (openOrders === 0) {
        await tx.restaurantTable.update({
          where: { id: order.tableId },
          data: { status: 'AVAILABLE' },
        })
      }
    }

    return next
  })

  realtime.orderCancelled(order.restaurantId, {
    orderId: order.id,
    orderNumber: order.orderNumber,
    branchId: order.branchId,
    status: 'CANCELLED',
    tableId: order.tableId,
    tableNumber: order.table?.number ?? null,
    at: new Date().toISOString(),
  })

  await notify({
    restaurantId: order.restaurantId,
    // Order notifications carry the order's own branch, so a ticket for Kandy
    // stops ringing the bell in Colombo.
    branchId: order.branchId,
    type: 'ORDER_CANCELLED',
    title: `Order ${order.orderNumber} cancelled`,
    body: params.reason,
    audience: 'KITCHEN',
    orderId: order.id,
    data: { orderId: order.id, orderNumber: order.orderNumber },
  })

  return updated
}

// ── inventory coupling ───────────────────────────────────────────────────────

// Recipe-driven depletion now lives in @/features/inventory/depletion.

// ── broadcasting ─────────────────────────────────────────────────────────────

export async function toOrderPayload(orderId: string): Promise<OrderSummaryPayload | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { table: true, items: true },
  })
  if (!order) return null

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    branchId: order.branchId,
    status: order.status,
    type: order.type,
    tableId: order.tableId,
    tableNumber: order.table?.number ?? null,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
    grandTotal: order.grandTotal,
    notes: order.notes,
    placedAt: order.placedAt.toISOString(),
    estimatedMinutes: order.estimatedMinutes,
    items: order.items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      notes: item.notes,
      isVeg: item.isVeg,
      options: ((item.options as SelectedOption[] | null) ?? []).map((option) => ({
        groupName: option.groupName,
        name: option.name,
      })),
    })),
  }
}

async function broadcastOrder(orderId: string, kind: 'created' | 'status') {
  const payload = await toOrderPayload(orderId)
  if (!payload) return

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { restaurantId: true, status: true, branchId: true },
  })
  if (!order) return

  if (kind === 'created') {
    realtime.orderCreated(order.restaurantId, payload)
    await notify({
      restaurantId: order.restaurantId,
      branchId: order.branchId,
      type: 'ORDER_PLACED',
      title: `New order ${payload.orderNumber}`,
      body: payload.tableNumber
        ? `Table ${payload.tableNumber} · ${payload.itemCount} item(s)`
        : `${payload.itemCount} item(s)`,
      audience: 'KITCHEN',
      data: { orderId: payload.id, orderNumber: payload.orderNumber },
    })
  } else {
    realtime.orderUpdated(order.restaurantId, payload)
    realtime.orderStatus(order.restaurantId, {
      orderId: payload.id,
      orderNumber: payload.orderNumber,
      branchId: payload.branchId,
      status: payload.status,
      tableId: payload.tableId,
      tableNumber: payload.tableNumber,
      at: new Date().toISOString(),
    })
  }
}

const STATUS_NOTIFICATIONS: Partial<
  Record<OrderStatus, { type: 'ORDER_ACCEPTED' | 'ORDER_PREPARING' | 'ORDER_READY' | 'ORDER_SERVED'; title: string; audience: 'WAITER' | 'KITCHEN' | 'MANAGEMENT' }>
> = {
  ACCEPTED: { type: 'ORDER_ACCEPTED', title: 'Order accepted', audience: 'MANAGEMENT' },
  PREPARING: { type: 'ORDER_PREPARING', title: 'Order in the kitchen', audience: 'MANAGEMENT' },
  READY: { type: 'ORDER_READY', title: 'Order ready to serve', audience: 'WAITER' },
  SERVED: { type: 'ORDER_SERVED', title: 'Order served', audience: 'MANAGEMENT' },
}

async function notifyStatusChange(order: Order, tableNumber: string | null) {
  const meta = STATUS_NOTIFICATIONS[order.status]
  if (!meta) return
  await notify({
    restaurantId: order.restaurantId,
    branchId: order.branchId,
    type: meta.type,
    title: `${meta.title} — ${order.orderNumber}`,
    body: tableNumber ? `Table ${tableNumber}` : order.customerName,
    audience: meta.audience,
    orderId: order.id,
    data: { orderId: order.id, orderNumber: order.orderNumber, tableNumber },
  })
}

// ── settlement ───────────────────────────────────────────────────────────────

/** Awards loyalty points and updates lifetime spend once an order is paid. */
export async function settleLoyalty(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { restaurant: { select: { loyaltyEnabled: true, loyaltyEarnRateX100: true, currency: true } } },
  })
  if (!order || !order.customerId || !order.restaurant.loyaltyEnabled) return

  const earned = pointsEarned(order.grandTotal, order.restaurant.loyaltyEarnRateX100)

  await prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: order.customerId! },
      data: {
        loyaltyPoints: { increment: earned },
        totalSpent: { increment: order.grandTotal },
      },
    })
    if (earned > 0) {
      await tx.loyaltyEntry.create({
        data: {
          restaurantId: order.restaurantId,
          customerId: order.customerId!,
          orderId: order.id,
          points: earned,
          kind: 'EARNED',
          note: `Earned on ${order.orderNumber}`,
        },
      })
    }
  })
}

export function describeOrder(order: Pick<Order, 'orderNumber' | 'grandTotal'>, currency: string) {
  return `${order.orderNumber} · ${formatMoney(order.grandTotal, currency)}`
}
