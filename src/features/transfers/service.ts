import 'server-only'

import type { StockTransfer, TransferStatus, TransferVarianceReason, UserRole } from '@prisma/client'

import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { canAccessBranch } from '@/lib/rbac'
import { prisma, type TxClient, guardLocks} from '@/server/db/prisma'
import { postMovement } from '@/features/inventory/ledger'
import { applyLocationDelta, assertSufficient } from '@/features/inventory/location-stock'
import { roundQty } from '@/lib/quantity'

/**
 * Inter-location stock transfers.
 *
 * ── When stock actually moves ───────────────────────────────────────────────
 *
 *   REQUESTED  — nothing moves. A request is a question, not a commitment.
 *   APPROVED   — nothing moves either; the source reserves the quantity so it
 *                cannot be promised twice, but it is still physically there.
 *   DISPATCHED — the source's available stock falls and the destination's
 *                in-transit rises. The stock is in a van, belonging to neither
 *                location's sellable figure.
 *   RECEIVED   — the destination's available rises, in-transit clears.
 *
 * That sequence is the whole point. Crediting the destination at approval, or
 * debiting the source at request, would let the same chicken be counted in two
 * places at once.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * Every state change is guarded by the transfer's current status inside the
 * transaction that changes it. Dispatching twice fails the second time because
 * the row is no longer DISPATCHABLE, so a double-click cannot move stock twice.
 */

const ALLOWED: Record<TransferStatus, TransferStatus[]> = {
  // A draft is still being written. It reserves nothing and appears in nobody's
  // queue; submitting it is what makes it a request.
  DRAFT: ['REQUESTED', 'CANCELLED'],
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['DISPATCHED', 'CANCELLED'],
  /*
   * CANCELLED is reachable from here, and it has to be.
   *
   * Without it a van that is redirected, lost, or sent to a site that has
   * closed leaves the stock out of the source's `available` and sitting in the
   * destination's `inTransit` for ever, with no path in the app to get it
   * back. A manual adjustment at each end does not help: adjustments touch
   * `available` and never `inTransit`, so the phantom inbound quantity stays.
   *
   * Cancelling from here is a real stock movement, not a status change — see
   * `recallTransfer`.
   */
  DISPATCHED: ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'],
  IN_TRANSIT: ['RECEIVED'],
  // Arrived, but short or damaged, so somebody still has to sign the variance
  // off. A clean delivery skips this and completes on receipt.
  RECEIVED: ['COMPLETED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
}

export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

export interface TransferLineInput {
  itemId: string
  quantity: number
  batchId?: string | null
}

/** Highest issued number under a lock — a count races and breaks on deletes. */
async function nextNumber(tx: TxClient, restaurantId: string): Promise<string> {
  /*
   * Serialise numbering per tenant with an advisory lock, not a row lock.
   *
   * This used to be `SELECT id FROM restaurants ... FOR UPDATE`, which looked
   * like a cheap per-tenant mutex and was in fact a site-wide outage waiting to
   * happen. `restaurants` is the parent of thirty-odd foreign keys, and every
   * INSERT into any child table makes Postgres take `FOR KEY SHARE` on the
   * parent row to check referential integrity. `FOR KEY SHARE` conflicts with
   * exactly one mode — `FOR UPDATE`. So for as long as one purchase order or
   * transfer was being numbered, every insert belonging to that restaurant
   * blocked: branches, orders, order items, stock movements, audit rows,
   * everything. With no lock_timeout those waits never ended.
   *
   * An advisory lock takes no row lock at all, so no referential-integrity
   * check ever contends with it. `pg_advisory_xact_lock` is transaction-scoped
   * and released on commit or rollback, which also makes it safe behind a
   * transaction-mode pooler — unlike the session-scoped variety.
   */
  // $executeRaw, not $queryRaw: the function returns void and Prisma cannot
  // deserialise a void column into a row.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}))`
  const rows = await tx.stockTransfer.findMany({
    where: { restaurantId }, orderBy: { number: 'desc' }, take: 1, select: { number: true },
  })
  const last = Number(rows[0]?.number?.split('-')[1] ?? 0)
  return `TRF-${String((Number.isFinite(last) ? last : 0) + 1).padStart(6, '0')}`
}

/**
 * Both ends must belong to the caller's restaurant — never trust an id.
 *
 * The two ends may be the same location provided the shelves differ: moving
 * stock from the main store to the cold room is a real movement worth
 * recording, even though the branch total does not change.
 */
async function requireLocations(
  restaurantId: string,
  fromId: string,
  toId: string,
  fromStorageId?: string | null,
  toStorageId?: string | null,
) {
  if (fromId === toId && (!fromStorageId || !toStorageId || fromStorageId === toStorageId)) {
    throw new AppError(
      'Choose two different places — either another location, or another storage area within this one',
      400,
      'TRANSFER_SAME_LOCATION',
    )
  }

  const branchIds = fromId === toId ? [fromId] : [fromId, toId]
  const locations = await prisma.branch.findMany({
    where: { id: { in: branchIds }, restaurantId, deletedAt: null },
    select: { id: true, name: true, type: true },
  })
  if (locations.length !== branchIds.length) throw new NotFoundError('Location')

  // A shelf must belong to the location it is named for, or stock would move to
  // a store that is not there.
  const storageIds = [fromStorageId, toStorageId].filter((id): id is string => Boolean(id))
  if (storageIds.length > 0) {
    const stores = await prisma.storageLocation.findMany({
      where: { id: { in: storageIds }, restaurantId, deletedAt: null },
      select: { id: true, branchId: true },
    })
    if (stores.length !== new Set(storageIds).size) throw new NotFoundError('Storage area')

    const fromStore = stores.find((s) => s.id === fromStorageId)
    const toStore = stores.find((s) => s.id === toStorageId)
    if (fromStore && fromStore.branchId !== fromId) {
      throw new AppError('That storage area is not at the source location', 400, 'TRANSFER_BAD_STORAGE')
    }
    if (toStore && toStore.branchId !== toId) {
      throw new AppError('That storage area is not at the destination', 400, 'TRANSFER_BAD_STORAGE')
    }
  }

  const from = locations.find((l) => l.id === fromId)!
  return { from, to: locations.find((l) => l.id === toId) ?? from }
}

export async function requestTransfer(params: {
  restaurantId: string
  fromBranchId: string
  toBranchId: string
  /** Optional shelves. Same branch on both sides makes it a store-to-store move. */
  fromStorageId?: string | null
  toStorageId?: string | null
  lines: TransferLineInput[]
  notes?: string | null
  userId?: string | null
}): Promise<StockTransfer> {
  if (params.lines.length === 0) {
    throw new AppError('Add at least one item to the transfer', 400, 'TRANSFER_EMPTY')
  }
  for (const line of params.lines) {
    if (!(line.quantity > 0)) {
      throw new AppError('Every line needs a quantity above zero', 400, 'TRANSFER_BAD_QTY')
    }
  }

  await requireLocations(
    params.restaurantId,
    params.fromBranchId,
    params.toBranchId,
    params.fromStorageId,
    params.toStorageId,
  )

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: params.lines.map((l) => l.itemId) }, restaurantId: params.restaurantId },
    select: { id: true, unit: true, costPerUnit: true },
  })
  if (items.length !== new Set(params.lines.map((l) => l.itemId)).size) {
    throw new NotFoundError('Inventory item')
  }
  const byId = new Map(items.map((i) => [i.id, i]))

  return prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, params.restaurantId)
    return tx.stockTransfer.create({
      data: {
        restaurantId: params.restaurantId,
        number,
        fromBranchId: params.fromBranchId,
        toBranchId: params.toBranchId,
        fromStorageId: params.fromStorageId ?? null,
        toStorageId: params.toStorageId ?? null,
        status: 'REQUESTED',
        notes: params.notes?.trim() || null,
        requestedById: params.userId ?? null,
        lines: {
          create: params.lines.map((l) => ({
            itemId: l.itemId,
            requestedQty: l.quantity,
            unit: byId.get(l.itemId)!.unit,
            unitCost: byId.get(l.itemId)!.costPerUnit,
            batchId: l.batchId ?? null,
          })),
        },
      },
    })
  })
}

/**
 * Approve a request and reserve the stock at the source.
 *
 * Reserving does not move anything — the goods are still on the source's shelf.
 * It stops the same stock being promised to a second transfer before this one
 * leaves, which is the failure an approval step exists to prevent.
 */
export async function approveTransfer(params: {
  restaurantId: string
  transferId: string
  userId?: string | null
}): Promise<StockTransfer> {
  return prisma.$transaction(async (tx) => {
    const transfer = await load(tx, params.restaurantId, params.transferId)
    assertTransition(transfer.status, 'APPROVED')

    for (const line of transfer.lines) {
      await assertSufficient(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        branchId: transfer.fromBranchId,
        storageLocationId: transfer.fromStorageId,
        quantity: line.requestedQty,
        itemName: line.item.name,
      })
      await applyLocationDelta(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        branchId: transfer.fromBranchId,
        storageLocationId: transfer.fromStorageId,
        reserved: line.requestedQty,
      })
    }

    return tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: 'APPROVED', approvedById: params.userId ?? null, approvedAt: new Date() },
    })
  })
}

/**
 * Send the goods.
 *
 * This is where stock genuinely leaves the source. The dispatched quantity is
 * recorded and never overwritten by what turns up at the far end, so a shortfall
 * on arrival stays visible instead of being quietly reconciled away.
 */
export async function dispatchTransfer(params: {
  restaurantId: string
  transferId: string
  /** Per line, when less is actually sent than was approved. */
  sent?: Array<{ lineId: string; quantity: number }>
  userId?: string | null
}): Promise<StockTransfer> {
  const overrides = new Map((params.sent ?? []).map((s) => [s.lineId, s.quantity]))

  return prisma.$transaction(async (tx) => {
    const transfer = await load(tx, params.restaurantId, params.transferId)
    assertTransition(transfer.status, 'DISPATCHED')

    /*
     * ── Every reservation is released, before anything can skip a line ──────
     *
     * Approving reserved the full requested quantity on every line, so
     * dispatching has to give all of it back whether that line ships in full,
     * in part, or not at all. This release used to sit inside the loop below,
     * *after* `if (sentQty <= 0) continue` — so a line sent as zero kept its
     * reservation, the transfer moved to DISPATCHED, and `closeTransfer` only
     * releases from APPROVED. That stock was then locked out of the source's
     * free balance permanently.
     *
     * Permanently is the right word: `reserved` is not derivable from the
     * movement ledger, so no report could show it and
     * `scripts/repair-branch-stock.ts` says in as many words that it cannot fix
     * it. A quantity that silently shrinks a branch's usable stock for ever is
     * worth a separate pass over the lines.
     */
    for (const line of transfer.lines) {
      await applyLocationDelta(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        branchId: transfer.fromBranchId,
        storageLocationId: transfer.fromStorageId,
        reserved: -line.requestedQty,
      })
    }

    for (const line of transfer.lines) {
      const sentQty = overrides.get(line.id) ?? line.requestedQty
      // Nothing on this line. Its reservation is already back above.
      if (sentQty <= 0) continue
      if (sentQty > line.requestedQty + 1e-6) {
        throw new AppError(
          `${line.item.name}: cannot send more than the ${line.requestedQty} approved`,
          400,
          'TRANSFER_OVER_SEND',
        )
      }

      await assertSufficient(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        branchId: transfer.fromBranchId,
        storageLocationId: transfer.fromStorageId,
        quantity: sentQty,
        itemName: line.item.name,
      })

      await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        type: 'TRANSFER_OUT',
        quantity: sentQty,
        reason: `Transfer ${transfer.number} to ${transfer.toBranch.name}`,
        referenceType: 'StockTransfer',
        referenceId: transfer.id,
        branchId: transfer.fromBranchId,
        locationId: transfer.fromStorageId,
        batchId: line.batchId,
        userId: params.userId,
      })

      // The goods are now in a van: nobody's available stock, but visible as
      // inbound at the destination.
      await applyLocationDelta(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        branchId: transfer.toBranchId,
        storageLocationId: transfer.toStorageId,
        inTransit: sentQty,
      })

      await tx.stockTransferLine.update({ where: { id: line.id }, data: { sentQty } })
    }

    return tx.stockTransfer.update({
      where: { id: transfer.id },
      data: {
        status: 'DISPATCHED',
        dispatchedById: params.userId ?? null,
        dispatchedAt: new Date(),
      },
    })
  })
}

export interface ReceiveLineInput {
  lineId: string
  receivedQty: number
  varianceReason?: TransferVarianceReason | null
  varianceNote?: string | null
}

/**
 * Take delivery.
 *
 * A shortfall demands a reason. Accepting 28 of 30 without one would let stock
 * evaporate with nothing recorded, which is exactly the leak a transfer system
 * exists to close.
 */
export async function receiveTransfer(params: {
  restaurantId: string
  transferId: string
  lines: ReceiveLineInput[]
  userId?: string | null
}): Promise<{ transfer: StockTransfer; variances: number }> {
  const byLine = new Map(params.lines.map((l) => [l.lineId, l]))

  return prisma.$transaction(async (tx) => {
    const transfer = await load(tx, params.restaurantId, params.transferId)
    if (transfer.status !== 'DISPATCHED' && transfer.status !== 'IN_TRANSIT') {
      throw new AppError(
        'Only a dispatched transfer can be received',
        409,
        'TRANSFER_NOT_DISPATCHED',
      )
    }

    let variances = 0

    for (const line of transfer.lines) {
      const sentQty = line.sentQty ?? 0
      if (sentQty <= 0) continue

      /*
       * An absent line is not an acceptance.
       *
       * This defaulted a line that was not in the payload to the full `sentQty`
       * with no reason required, so a receive naming one line silently signed
       * for the whole delivery — and signing for stock is what puts it on the
       * shelf and ends anyone's ability to query it. Receiving what was sent is
       * still one click; the client sends every line to say so.
       */
      const input = byLine.get(line.id)
      if (!input) {
        throw new AppError(
          `${line.item.name}: say how much arrived`,
          400,
          'TRANSFER_LINE_MISSING',
        )
      }
      const receivedQty = input.receivedQty
      if (receivedQty < 0) {
        throw new AppError('A received quantity cannot be negative', 400, 'TRANSFER_NEGATIVE')
      }
      if (receivedQty > sentQty + 1e-6) {
        throw new AppError(
          `${line.item.name}: more arrived than was sent — check the dispatch`,
          400,
          'TRANSFER_OVER_RECEIVE',
        )
      }

      const variance = roundQty(receivedQty - sentQty)
      if (variance < 0 && !input.varianceReason) {
        throw new AppError(
          `${line.item.name}: ${Math.abs(variance)} short — give a reason`,
          400,
          'TRANSFER_VARIANCE_NO_REASON',
        )
      }

      if (receivedQty > 0) {
        await postMovement(tx, {
          restaurantId: params.restaurantId,
          itemId: line.itemId,
          type: 'TRANSFER_IN',
          quantity: receivedQty,
          reason: `Transfer ${transfer.number} from ${transfer.fromBranch.name}`,
          referenceType: 'StockTransfer',
          referenceId: transfer.id,
          branchId: transfer.toBranchId,
          locationId: transfer.toStorageId,
          batchId: line.batchId,
          userId: params.userId,
        })
      }

      // The whole dispatched quantity leaves in-transit, including anything
      // that went missing — it is no longer on its way, it is simply gone, and
      // the variance is what records that.
      await applyLocationDelta(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        branchId: transfer.toBranchId,
        storageLocationId: transfer.toStorageId,
        inTransit: -sentQty,
      })

      if (variance !== 0) variances += 1

      await tx.stockTransferLine.update({
        where: { id: line.id },
        data: {
          receivedQty,
          variance,
          varianceReason: input.varianceReason ?? null,
          varianceNote: input.varianceNote?.trim() || null,
        },
      })
    }

    /*
     * A clean delivery is finished; a short one is not.
     *
     * Receiving always wrote COMPLETED, which left RECEIVED unreachable — a
     * state in the machine that nothing could ever enter. That also meant a
     * transfer where four of twenty kilos went missing closed itself with the
     * shortfall recorded and nobody asked to look at it.
     *
     * So the two outcomes are now different. Everything arrived: COMPLETED, as
     * before, with no extra clicking for the ordinary case. Something did not:
     * RECEIVED, which is where the variance waits for someone to accept it —
     * `RECEIVED → COMPLETED` was already the last edge in the table.
     */
    const updated = await tx.stockTransfer.update({
      where: { id: transfer.id },
      data: {
        status: variances > 0 ? 'RECEIVED' : 'COMPLETED',
        receivedById: params.userId ?? null,
        receivedAt: new Date(),
      },
    })

    return { transfer: updated, variances }
  })
}

/**
 * Sign off a delivery that arrived short or damaged.
 *
 * The stock has already moved — `receiveTransfer` credited what actually turned
 * up — so this changes nothing but the status. It is the human step: somebody
 * has looked at the shortfall and accepted it.
 */
export async function completeTransfer(params: {
  restaurantId: string
  transferId: string
  userId?: string | null
}): Promise<StockTransfer> {
  return prisma.$transaction(async (tx) => {
    const transfer = await load(tx, params.restaurantId, params.transferId)
    assertTransition(transfer.status, 'COMPLETED')
    return tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: 'COMPLETED' },
    })
  })
}

/** Reject or cancel, releasing any reservation the approval made. */
export async function closeTransfer(params: {
  restaurantId: string
  transferId: string
  status: 'REJECTED' | 'CANCELLED'
  reason?: string | null
  userId?: string | null
}): Promise<StockTransfer> {
  return prisma.$transaction(async (tx) => {
    const transfer = await load(tx, params.restaurantId, params.transferId)
    assertTransition(transfer.status, params.status)

    /*
     * A dispatched transfer has real stock in the air, so cancelling it means
     * moving that stock back — which is `recallTransfer`, not this. Refused
     * here rather than silently marking it cancelled and stranding the goods.
     */
    if (transfer.status === 'DISPATCHED' || transfer.status === 'IN_TRANSIT') {
      throw new AppError(
        'This has already left. Recall it instead, so the stock comes back to the source.',
        409,
        'TRANSFER_ALREADY_SENT',
      )
    }

    if (transfer.status === 'APPROVED') {
      for (const line of transfer.lines) {
        await applyLocationDelta(tx, {
          restaurantId: params.restaurantId,
          itemId: line.itemId,
          branchId: transfer.fromBranchId,
          storageLocationId: transfer.fromStorageId,
          reserved: -line.requestedQty,
        })
      }
    }

    return tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: params.status, rejectReason: params.reason?.trim() || null },
    })
  })
}

/**
 * Bring a dispatched transfer back to where it came from.
 *
 * ── Why this is a movement and not a status change ──────────────────────────
 *
 * At dispatch the source really lost the stock — a `TRANSFER_OUT` is in the
 * ledger — and the destination really shows it inbound. Marking the row
 * CANCELLED would leave both of those facts standing: the source stays short,
 * the destination keeps a phantom `inTransit` that nothing can ever clear, and
 * the two ends disagree with the item's own total for ever.
 *
 * So a recall posts the opposite movement. The ledger then reads out-and-back,
 * which is what actually happened, and the reconciliation replays to the same
 * number it started at.
 *
 * `sentQty` and not `requestedQty`: what comes home is what left, which on a
 * partial dispatch are different numbers.
 */
export async function recallTransfer(params: {
  restaurantId: string
  transferId: string
  reason: string
  userId?: string | null
}): Promise<StockTransfer> {
  const reason = params.reason.trim()
  if (reason.length < 2) {
    throw new AppError('Say why it is coming back', 400, 'TRANSFER_NO_RECALL_REASON')
  }

  return prisma.$transaction(async (tx) => {
    const transfer = await load(tx, params.restaurantId, params.transferId)
    if (transfer.status !== 'DISPATCHED' && transfer.status !== 'IN_TRANSIT') {
      throw new AppError(
        'Only a transfer that has left can be recalled',
        409,
        'TRANSFER_NOT_SENT',
      )
    }

    for (const line of transfer.lines) {
      const sentQty = line.sentQty ?? 0
      if (sentQty <= 0) continue

      // Back onto the source's shelf, as a real inbound movement.
      await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        type: 'TRANSFER_IN',
        quantity: sentQty,
        reason: `Recalled from transfer ${transfer.number} — ${reason}`,
        referenceType: 'StockTransfer',
        referenceId: transfer.id,
        branchId: transfer.fromBranchId,
        locationId: transfer.fromStorageId,
        batchId: line.batchId,
        userId: params.userId,
      })

      // And out of the destination's inbound column, which is the half a
      // manual adjustment could never reach.
      await applyLocationDelta(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        branchId: transfer.toBranchId,
        storageLocationId: transfer.toStorageId,
        inTransit: -sentQty,
      })
    }

    return tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: 'CANCELLED', rejectReason: reason },
    })
  })
}

/**
 * Load a transfer with its row locked for the rest of the transaction.
 *
 * The lock is the whole reason this is not a plain findFirst. Every state
 * change here is read-modify-write — read the status, decide, write — and
 * without a lock five simultaneous dispatches all read REQUESTED, all decide
 * they may proceed, and all move the stock. Measured before this: five
 * concurrent dispatches of 10 units took 50 from a balance of 30 and left it
 * at −20, with 50 showing in transit at the far end.
 *
 * Postgres releases the lock on commit or rollback, so a crash cannot strand a
 * transfer.
 */
async function load(tx: TxClient, restaurantId: string, transferId: string) {
  await guardLocks(tx)
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM stock_transfers
    WHERE id = ${transferId} AND "restaurantId" = ${restaurantId}
    FOR UPDATE
  `
  if (locked.length === 0) throw new NotFoundError('Transfer')

  const transfer = await tx.stockTransfer.findFirst({
    where: { id: transferId, restaurantId },
    include: {
      lines: { include: { item: { select: { id: true, name: true, unit: true } } } },
      fromBranch: { select: { id: true, name: true } },
      toBranch: { select: { id: true, name: true } },
    },
  })
  if (!transfer) throw new NotFoundError('Transfer')
  return transfer
}

function assertTransition(from: TransferStatus, to: TransferStatus) {
  if (!canTransition(from, to)) {
    throw new AppError(
      `A ${from.replace(/_/g, ' ').toLowerCase()} transfer cannot become ${to.replace(/_/g, ' ').toLowerCase()}`,
      409,
      'TRANSFER_BAD_TRANSITION',
    )
  }
}


/**
 * Which end of a transfer a person must be standing at to do something to it.
 *
 * The old rule was one line — `assertBranchAccess(user, fromBranchId)` on
 * request, and nothing at all on approve, dispatch, receive or close — and it
 * was wrong in both directions.
 *
 * Wrong for the manager: a transfer request is a *question*, and the person
 * asking is almost always the destination. "Can Kandy have 20kg of sugar from
 * the warehouse?" was refused, because the Kandy manager has no access to the
 * warehouse. The one screen built for branch managers to pull stock could not
 * be used by a branch manager.
 *
 * Wrong for everyone else: with no check on the later steps, anyone holding the
 * permission could dispatch stock out of a location they have nothing to do
 * with, or receive goods into someone else's store. Permission answers "may
 * this person dispatch transfers"; it never answered "whose".
 *
 * So each step is guarded by the end it actually touches:
 *
 *   request   either end — asking to pull, or offering to push
 *   approve   source     — approval reserves the source's stock
 *   dispatch  source     — the stock leaves that building
 *   receive   destination — it arrives in this one
 *   close     either end — either side may call it off
 *
 * An unrestricted user (owner, admin, group manager) passes every one of these.
 */
export type TransferSide = 'SOURCE' | 'DESTINATION' | 'EITHER'

export function assertTransferSide(
  user: { role: UserRole; branchId?: string | null },
  transfer: { fromBranchId: string; toBranchId: string },
  side: TransferSide,
): void {
  const atSource = canAccessBranch(user, transfer.fromBranchId)
  const atDestination = canAccessBranch(user, transfer.toBranchId)

  const allowed =
    side === 'SOURCE' ? atSource : side === 'DESTINATION' ? atDestination : atSource || atDestination

  if (allowed) return

  throw new ForbiddenError(
    side === 'SOURCE'
      ? 'Only someone at the sending location can do that'
      : side === 'DESTINATION'
        ? 'Only someone at the receiving location can do that'
        : 'You do not have access to either location on this transfer',
  )
}

/** The two ends of a transfer, for a guard that runs before the service does. */
export async function transferEnds(restaurantId: string, transferId: string) {
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: transferId, restaurantId },
    select: { id: true, fromBranchId: true, toBranchId: true },
  })
  if (!transfer) throw new NotFoundError('Transfer')
  return transfer
}
