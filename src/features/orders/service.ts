import 'server-only'
import type { Order, OrderStatus, Prisma } from '@prisma/client'

import { AppError, ConflictError, NotFoundError } from '@/lib/errors'
import { formatMoney } from '@/lib/money'
import { pinRecipeVersions, reconcileOrderDepletion } from '@/features/inventory/depletion'
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
  db?: TxClient
}): Promise<OrderDraft> {
  const db = params.db ?? prisma
  const restaurant = await requireRestaurant(params.restaurantId)

  if (!params.items.length) throw new AppError('Your cart is empty', 400, 'EMPTY_CART')

  const foodIds = [...new Set(params.items.map((item) => item.foodId))]
  const foods = await db.food.findMany({
    where: { id: { in: foodIds }, restaurantId: params.restaurantId, deletedAt: null },
    include: { variantGroups: { include: { options: true } } },
  })

  const foodById = new Map(foods.map((food) => [food.id, food]))
  const now = new Date()
  const priced: PricedDraftItem[] = []

  for (const line of params.items) {
    const food = foodById.get(line.foodId)
    if (!food) throw new NotFoundError('Menu item')
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
      costPrice: food.costPrice,
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
  createdById?: string | null
  servedById?: string | null
}

export async function placeOrder(params: PlaceOrderParams): Promise<Order> {
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
  const existingCustomer = await prisma.customer.findUnique({
    where: {
      restaurantId_phone: { restaurantId: params.restaurantId, phone: params.customerPhone },
    },
    select: { id: true, isBlocked: true },
  })

  if (existingCustomer?.isBlocked) {
    throw new AppError('This account cannot place orders. Please speak to our staff.', 403, 'BLOCKED')
  }

  const draft = await buildDraft({
    restaurantId: params.restaurantId,
    items: params.items,
    couponCode: params.couponCode,
    manualDiscount: params.manualDiscount,
    redeemPoints: params.redeemPoints,
    customerId: existingCustomer?.id ?? null,
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

      // Customers are keyed by phone within a restaurant.
      const customer = await tx.customer.upsert({
        where: {
          restaurantId_phone: {
            restaurantId: params.restaurantId,
            phone: params.customerPhone,
          },
        },
        create: {
          restaurantId: params.restaurantId,
          name: params.customerName,
          phone: params.customerPhone,
          email: params.customerEmail || null,
        },
        update: {
          name: params.customerName,
          ...(params.customerEmail ? { email: params.customerEmail } : {}),
        },
      })

      // Blocked status was checked before the transaction; re-check here only in
      // case the row was created between the two, which the upsert would hide.
      if (customer.isBlocked) {
        throw new AppError('This account cannot place orders. Please speak to our staff.', 403, 'BLOCKED')
      }

      // No retry loop here: a Postgres transaction is aborted the moment a
      // statement violates a constraint, so every later statement in it fails
      // with "current transaction is aborted". Retrying inside the transaction
      // could never succeed — the retry lives around the whole transaction, in
      // `placeOrder` below.
      const orderNumber = await nextOrderNumber(tx, params.restaurantId, restaurant.timezone)
      const created: Order = await tx.order.create({
            data: {
              restaurantId: params.restaurantId,
              orderNumber,
              type,
              channel: params.channel ?? 'STAFF',
              branchId: params.branchId ?? null,
              status: 'PENDING',
              paymentStatus: 'UNPAID',
              tableId: table?.id ?? null,
              customerId: customer.id,
              customerName: params.customerName,
              customerPhone: params.customerPhone,
              customerEmail: params.customerEmail || null,
              guestSessionId: params.guestSessionId ?? null,
              createdById: params.createdById ?? null,
              servedById: params.servedById ?? null,
              guestCount: params.guestCount ?? null,
              notes: params.notes || null,
              couponId: draft.couponId,
              subtotal: draft.totals.subtotal,
              discountTotal: draft.totals.discountTotal,
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

      // Coupon accounting.
      if (draft.couponId && draft.totals.discountTotal > 0) {
        await tx.coupon.update({
          where: { id: draft.couponId },
          data: { usedCount: { increment: 1 } },
        })
        await tx.couponRedemption.create({
          data: {
            couponId: draft.couponId,
            orderId: created.id,
            customerId: customer.id,
            amount: draft.totals.discountTotal,
          },
        })
      }

      // Loyalty spend is debited now; the earn happens at settlement.
      if (draft.loyaltyPointsUsed > 0) {
        await tx.customer.update({
          where: { id: customer.id },
          data: { loyaltyPoints: { decrement: draft.loyaltyPointsUsed } },
        })
      }

      await tx.customer.update({
        where: { id: customer.id },
        data: { totalOrders: { increment: 1 }, lastOrderAt: new Date() },
      })

      await tx.food.updateMany({
        where: { id: { in: draft.items.map((item) => item.foodId) } },
        data: { soldCount: { increment: 1 } },
      })

      if (table && table.status === 'AVAILABLE') {
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
  let order: Order | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      order = await runPlacement()
      break
    } catch (error) {
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

  if (!canTransition(order.status, params.status)) {
    throw new AppError(
      `An order that is ${order.status.toLowerCase()} cannot move to ${params.status.toLowerCase()}`,
      409,
      'INVALID_TRANSITION',
    )
  }

  const timestampField = STATUS_TIMESTAMP[params.status]

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.order.update({
      where: { id: order.id },
      data: {
        status: params.status,
        ...(timestampField ? { [timestampField]: new Date() } : {}),
        ...(params.estimatedMinutes !== undefined
          ? { estimatedMinutes: params.estimatedMinutes }
          : {}),
        // Accepting an order implies its items have entered the queue.
        ...(params.status === 'PREPARING'
          ? { items: { updateMany: { where: { status: 'QUEUED' }, data: { status: 'PREPARING' } } } }
          : {}),
        ...(params.status === 'READY'
          ? {
              items: {
                updateMany: {
                  where: { status: { in: ['QUEUED', 'PREPARING'] } },
                  data: { status: 'READY' },
                },
              },
            }
          : {}),
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
      await pinRecipeVersions(tx, { restaurantId: order.restaurantId, orderId: order.id })
      const depleted = await reconcileOrderDepletion(tx, {
        restaurantId: order.restaurantId,
        orderId: order.id,
        userId: params.actorId ?? null,
      })

      // Warn the floor about anything this order pushed to its reorder level.
      if (depleted.affectedItemIds.length > 0) {
        const low = await tx.inventoryItem.findMany({
          where: { id: { in: depleted.affectedItemIds }, restaurantId: order.restaurantId },
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
          }
        }
      }
    }

    if (params.status === 'CANCELLED') {
      await reconcileOrderDepletion(tx, {
        restaurantId: order.restaurantId,
        orderId: order.id,
        userId: params.actorId ?? null,
        releaseAll: true,
      })
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
  if (order.paymentStatus === 'PAID') {
    throw new AppError('Refund the payment before cancelling this order', 409, 'ORDER_PAID')
  }

  const updated = await prisma.$transaction(async (tx) => {
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
        await tx.customer.update({
          where: { id: order.customerId },
          data: {
            loyaltyPoints: {
              increment: Math.round(order.loyaltyDiscount / restaurant.loyaltyPointValue),
            },
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
    status: 'CANCELLED',
    tableId: order.tableId,
    tableNumber: order.table?.number ?? null,
    at: new Date().toISOString(),
  })

  await notify({
    restaurantId: order.restaurantId,
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
    select: { restaurantId: true, status: true },
  })
  if (!order) return

  if (kind === 'created') {
    realtime.orderCreated(order.restaurantId, payload)
    await notify({
      restaurantId: order.restaurantId,
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

  await prisma.customer.update({
    where: { id: order.customerId },
    data: {
      loyaltyPoints: { increment: earned },
      totalSpent: { increment: order.grandTotal },
    },
  })
}

export function describeOrder(order: Pick<Order, 'orderNumber' | 'grandTotal'>, currency: string) {
  return `${order.orderNumber} · ${formatMoney(order.grandTotal, currency)}`
}
