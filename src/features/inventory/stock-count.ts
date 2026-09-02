import 'server-only'

import type { StockCount, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { guardLocks, prisma } from '@/server/db/prisma'
import { postMovement } from './ledger'
import { toBaseUnits } from './units'

/**
 * Physical stock counts.
 *
 * Counting is two steps on purpose, and the separation is the whole point of
 * this module:
 *
 *   1. Someone walks the store and records what is on the shelf. This writes
 *      count lines and moves nothing. A mistyped 5 instead of 50 is a wrong
 *      line on a draft, not a corrupted balance.
 *
 *   2. Someone with authority approves it. Only then is the variance posted to
 *      the ledger, as ordinary ADJUSTMENT_IN / ADJUSTMENT_OUT movements that
 *      reference the count.
 *
 * The system stock on each line is snapshotted when the line is entered, so a
 * sale that happens while the count is in progress does not silently change
 * what the counter was comparing against. That snapshot is also what the
 * approver sees, which means they are approving the variance that was actually
 * observed rather than one recomputed later.
 *
 * ── The snapshot is a LOCATION figure, not the group total ──────────────────
 *
 * This is the subtle half, and it was wrong: the snapshot used to come from
 * `InventoryItem.quantity`, which is the restaurant-wide cached total, while
 * approval posts the variance at `count.branchId` — one location. Counting a
 * branch correctly therefore produced a variance the size of everywhere else's
 * stock, and approving it destroyed that much at the branch. With 40kg at the
 * warehouse and 10kg here, a counter who correctly finds 10 recorded a variance
 * of −40 and approval drove this branch to −30.
 *
 * It never fired only because the count sheet was itself broken and offered no
 * items, so no count could reach approval. Both halves are fixed together, and
 * `scripts/stock-count-branch-test.ts` exists to keep them fixed.
 *
 * The figure is the SUM of the branch's shelves, never a single row. Sales post
 * with no storage location and receipts post to a named one, so a branch that
 * takes in 6 onto Cold Room and sells 2 holds `(branch, coldroom) = +6` and
 * `(branch, null) = −2`. Only the sum is a position. `getLocationBalance` in
 * `location-stock.ts` says the same thing for single-item reads; this is the
 * batched form of it.
 */

export interface CountLineInput {
  itemId: string
  countedQty: number
  unit?: StockUnit | null
  notes?: string | null
}

/** Start a count. Empty until lines are added. */
export async function openStockCount(params: {
  restaurantId: string
  /** Which location. Required, in step with the ledger. */
  branchId: string
  locationId?: string | null
  userId: string
  notes?: string | null
}): Promise<StockCount> {
  const reference = `SC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now()
    .toString(36)
    .slice(-4)
    .toUpperCase()}`

  return prisma.stockCount.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      locationId: params.locationId ?? null,
      reference,
      countedById: params.userId,
      notes: params.notes?.trim() || null,
      status: 'DRAFT',
    },
  })
}

/**
 * Record what was on the shelf. Writes lines only — no stock moves here.
 *
 * Re-counting an item overwrites its line rather than adding a second one, so
 * a counter who miskeys can simply count again.
 */
export async function recordCountLines(params: {
  restaurantId: string
  stockCountId: string
  lines: CountLineInput[]
}): Promise<{ recorded: number }> {
  const count = await requireDraft(params.restaurantId, params.stockCountId)
  if (params.lines.length === 0) {
    throw new AppError('Add at least one item to the count', 400, 'COUNT_EMPTY')
  }

  const itemIds = params.lines.map((l) => l.itemId)

  const [items, onHand, existing] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { id: { in: itemIds }, restaurantId: params.restaurantId },
    }),
    branchOnHand({
      restaurantId: params.restaurantId,
      itemIds,
      branchId: count.branchId,
      locationId: count.locationId,
    }),
    /*
     * The snapshot is taken ONCE, when a line is first entered, and re-saving
     * must not disturb it.
     *
     * The upsert used to rewrite `systemQty` on every save, and the count sheet
     * posts every filled field each time. So counting item A at 10:00 and item
     * B at 11:00 silently re-baselined A to the 11:00 balance and recomputed its
     * variance — absorbing an hour of real sales into "no discrepancy". That is
     * the precise opposite of what a count is for, and it defeats the snapshot
     * doctrine this file's header describes.
     */
    prisma.stockCountLine.findMany({
      where: { stockCountId: count.id, itemId: { in: itemIds } },
      select: { itemId: true, systemQty: true },
    }),
  ])

  const byId = new Map(items.map((i) => [i.id, i]))
  const snapshotted = new Map(existing.map((l) => [l.itemId, l.systemQty]))

  await prisma.$transaction(async (tx) => {
    for (const line of params.lines) {
      const item = byId.get(line.itemId)
      if (!item) throw new NotFoundError('Inventory item')
      /*
       * A retired item can still be re-saved if it is already on the sheet —
       * deactivating something mid-count must not strand the count — but it
       * cannot be added. Without this, `recordCountLines` took any id in the
       * restaurant, and a line for an item outside the sheet is one the
       * approver never sees and the ledger still posts.
       */
      if (!item.isActive && !snapshotted.has(item.id)) {
        throw new AppError(`${item.name} is no longer stocked`, 400, 'COUNT_ITEM_INACTIVE')
      }
      if (line.countedQty < 0) {
        throw new AppError(`${item.name}: a count cannot be negative`, 400, 'COUNT_NEGATIVE')
      }

      const countedBase = toBaseUnits(line.countedQty, line.unit ?? item.unit, item)
      const systemQty = snapshotted.get(item.id) ?? round(onHand.get(item.id) ?? 0)

      await tx.stockCountLine.upsert({
        where: { stockCountId_itemId: { stockCountId: count.id, itemId: item.id } },
        create: {
          stockCountId: count.id,
          itemId: item.id,
          systemQty,
          countedQty: countedBase,
          variance: round(countedBase - systemQty),
          enteredUnit: line.unit ?? item.unit,
          notes: line.notes?.trim() || null,
        },
        update: {
          countedQty: countedBase,
          variance: round(countedBase - systemQty),
          enteredUnit: line.unit ?? item.unit,
          notes: line.notes?.trim() || null,
        },
      })
    }
  })

  return { recorded: params.lines.length }
}

/**
 * What each item's book says is at this location, keyed by item.
 *
 * An item with no `InventoryStock` row reads zero and is absent from the map —
 * which is a real answer, not a missing one. Counting such an item into
 * existence is exactly right: finding 3kg of something the book has never heard
 * of at this branch is a discovery, and `applyLocationDelta` creates the row on
 * the first write by design.
 */
export async function branchOnHand(params: {
  restaurantId: string
  itemIds: string[]
  branchId: string
  /** A shelf-scoped count. `null` means the whole branch, summed. */
  locationId?: string | null
}): Promise<Map<string, number>> {
  if (params.itemIds.length === 0) return new Map()

  const rows = await prisma.inventoryStock.findMany({
    where: {
      restaurantId: params.restaurantId,
      itemId: { in: params.itemIds },
      branchId: params.branchId,
      ...(params.locationId ? { storageLocationId: params.locationId } : {}),
    },
    select: { itemId: true, available: true },
  })

  const total = new Map<string, number>()
  for (const row of rows) {
    total.set(row.itemId, (total.get(row.itemId) ?? 0) + row.available)
  }
  for (const [itemId, value] of total) total.set(itemId, round(value))
  return total
}

/** Hand the count to a manager. Still moves no stock. */
export async function submitStockCount(
  restaurantId: string,
  stockCountId: string,
): Promise<StockCount> {
  const count = await requireDraft(restaurantId, stockCountId)
  const lines = await prisma.stockCountLine.count({ where: { stockCountId: count.id } })
  if (lines === 0) {
    throw new AppError('Count nothing, approve nothing — add lines first', 400, 'COUNT_EMPTY')
  }
  return prisma.stockCount.update({
    where: { id: count.id },
    data: { status: 'AWAITING_APPROVAL' },
  })
}

/**
 * Approve a count and post its variances.
 *
 * This is the only place a count changes stock. Each non-zero variance becomes
 * an adjustment movement referencing the count, so the ledger explains where
 * the correction came from and who authorised it. Zero-variance lines post
 * nothing — an item that counted correctly should not clutter its own history.
 */
export async function approveStockCount(params: {
  restaurantId: string
  stockCountId: string
  userId: string
  notes?: string | null
  /**
   * Whether this person may sign off a count they recorded themselves.
   *
   * Maker-checker is the control that stops a storeman writing off what they
   * walked out with, so the default is no. But a one-person restaurant has no
   * second person, and refusing there would make counting impossible for the
   * businesses this is mostly sold to — so the action layer passes `true` for
   * an owner or admin, who have nobody above them to ask. Deciding it there
   * rather than here keeps this function about the count.
   */
  selfApprovalAllowed?: boolean
}): Promise<{ count: StockCount; adjusted: number; unchanged: number; valueDelta: number }> {
  return prisma.$transaction(async (tx) => {
    /*
     * Read the status INSIDE the lock.
     *
     * It used to be read before the transaction opened, so two approvers — or
     * one impatient double-click — both saw AWAITING_APPROVAL and both posted
     * the full variance, adjusting stock twice. Same shape as `payRequest` in
     * pettycash: take the row lock, re-read, then compare-and-swap the status so
     * the loser cannot commit.
     */
    await guardLocks(tx)
    await tx.$queryRaw`
      SELECT id FROM stock_counts WHERE id = ${params.stockCountId} FOR UPDATE
    `

    const count = await tx.stockCount.findFirst({
      where: { id: params.stockCountId, restaurantId: params.restaurantId },
      include: { lines: { include: { item: true } } },
    })
    if (!count) throw new NotFoundError('Stock count')
    if (count.status === 'APPROVED') {
      throw new AppError('That count was already approved', 409, 'COUNT_APPROVED')
    }
    if (count.status === 'CANCELLED') {
      throw new AppError('That count was cancelled', 409, 'COUNT_CANCELLED')
    }
    if (count.lines.length === 0) {
      throw new AppError('Nothing to approve', 400, 'COUNT_EMPTY')
    }
    if (!params.selfApprovalAllowed && count.countedById === params.userId) {
      throw new AppError(
        'Somebody else has to sign off a count you took yourself',
        403,
        'COUNT_SELF_APPROVAL',
      )
    }

    let adjusted = 0
    let unchanged = 0
    /*
     * What the count is worth, signed, minor units. A variance is not just a
     * quantity — 2kg of saffron missing and 2kg of salt missing are different
     * events — and the person signing should be signing a money figure. Valued
     * at each item's running average, the same cost the ledger stamps on the
     * adjustment rows this approval posts.
     */
    let valueDelta = 0

    for (const line of count.lines) {
      if (Math.abs(line.variance) < 1e-6) {
        unchanged += 1
        continue
      }
      valueDelta += Math.round(line.variance * line.item.costPerUnit)

      /*
       * The stored variance, deliberately — not one recomputed now.
       *
       * A count is a statement about a moment: this is what was on the shelf
       * when somebody looked. Re-deriving at approval time would silently fold
       * in everything that moved since, and the approver would be signing off a
       * number nobody observed. (A comment here used to claim the opposite of
       * what the code does. It was the comment that was wrong.)
       */
      await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        type: line.variance > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        quantity: Math.abs(line.variance),
        enteredUnit: line.item.unit,
        reason: `Stock count ${count.reference}`,
        notes: line.notes,
        referenceType: 'StockCount',
        referenceId: count.id,
        stockCountId: count.id,
        branchId: count.branchId,
        locationId: count.locationId,
        userId: params.userId,
      })
      adjusted += 1
    }

    const claimed = await tx.stockCount.updateMany({
      where: { id: count.id, status: count.status },
      data: {
        status: 'APPROVED',
        approvedById: params.userId,
        approvedAt: new Date(),
        notes: params.notes?.trim() || count.notes,
      },
    })
    if (claimed.count === 0) {
      throw new AppError('That count changed while you were approving it', 409, 'COUNT_RACE')
    }

    const updated = await tx.stockCount.findUniqueOrThrow({ where: { id: count.id } })
    return { count: updated, adjusted, unchanged, valueDelta }
  })
}

export async function cancelStockCount(
  restaurantId: string,
  stockCountId: string,
): Promise<StockCount> {
  const count = await prisma.stockCount.findFirst({
    where: { id: stockCountId, restaurantId },
  })
  if (!count) throw new NotFoundError('Stock count')
  if (count.status === 'APPROVED') {
    throw new AppError('An approved count cannot be cancelled', 409, 'COUNT_APPROVED')
  }
  return prisma.stockCount.update({ where: { id: count.id }, data: { status: 'CANCELLED' } })
}

async function requireDraft(restaurantId: string, stockCountId: string): Promise<StockCount> {
  const count = await prisma.stockCount.findFirst({
    where: { id: stockCountId, restaurantId },
  })
  if (!count) throw new NotFoundError('Stock count')
  if (count.status !== 'DRAFT') {
    throw new AppError('This count is no longer open for editing', 409, 'COUNT_NOT_DRAFT')
  }
  return count
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
