'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { actingBranchId } from '@/features/dashboard/selected-branch'
import { upsertReservation } from './reservations'
import { openServiceRequest } from './service-requests'
import { callWaiterSchema } from '@/features/orders/schema'
import { swapTableSchema, swapTargetsSchema } from './schema'
import { swapTable } from './service'
import { tableStatesFor } from './table-state-server'
import { toOrderPayload } from '@/features/orders/service'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { resolveBranchId } from '@/features/branches/service'
import { isUniqueViolation, prisma } from '@/server/db/prisma'
import { realtime } from '@/server/realtime/emitter'
import {
  bulkTablesSchema,
  reservationSchema,
  serviceTableStatusSchema,
  tableSchema,
  moveTableSchema,
  updateTableStatusSchema,
} from './schema'

// ── tables ───────────────────────────────────────────────────────────────────

export async function saveTable(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    tableSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TABLE_MANAGE)

      // Never trust the posted id, and never leave it unset: a table without a
      // branch cannot be reached by a QR.
      await assertBranchAccess(user, data.branchId || null)
      /*
       * The branch on screen, not the caller's home branch.
       *
       * `resolveBranchId(..., userBranchId)` was the fallback, and an owner has
       * no home branch — so with the form sending nothing, both candidates were
       * null and every table an owner created landed on the restaurant's
       * DEFAULT branch, whatever the switcher said. That is why every table in
       * this system sits at Main, why Branch 01's QR sheet had no table cards,
       * and ultimately why guests scanning Branch 01 reached Main's kitchen.
       *
       * The form now sends a branch explicitly. `actingBranchId` reads the same
       * cookie the switcher writes and is the belt to that braces: a payload
       * without one still lands where the owner is looking, never on Main by
       * default.
       */
      const branchId = data.branchId || (await actingBranchId(user))

      const payload = {
        branchId,
        number: data.number.toUpperCase(),
        label: data.label || null,
        area: data.area || 'Main',
        capacity: data.capacity,
        status: data.status,
        notes: data.notes || null,
      }

      try {
        let record
        if (data.id) {
          const existing = await prisma.restaurantTable.findFirst({
            where: { id: data.id, restaurantId: user.restaurantId },
          })
          if (!existing) throw new NotFoundError('Table')
          await assertRecordBranch(user, existing, 'table')
          /*
           * A table does not move house.
           *
           * `payload` carries the branch this user resolved to, so editing a
           * table's seat count from another location silently dragged the table
           * — and every order ever taken at it — into that location. Creating a
           * table still chooses a branch; editing one never changes it.
           */
          const { branchId: _ignored, ...withoutBranch } = payload
          record = await prisma.restaurantTable.update({
            where: { id: data.id },
            data: withoutBranch,
          })
        } else {
          record = await prisma.restaurantTable.create({
            data: { ...payload, restaurantId: user.restaurantId },
          })
        }

        realtime.tableUpdated(user.restaurantId, {
          id: record.id,
          number: record.number,
          status: record.status,
          branchId: record.branchId,
        })
        revalidatePath('/dashboard/tables')
        return { id: record.id }
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Scoped per branch now, so the message has to be too — "Table 1
          // already exists" reads as a lie when Kandy has one and this is
          // Colombo.
          throw new ConflictError(`Table ${data.number} already exists at this location`)
        }
        throw error
      }
    },
    'Table saved.',
  )
}

/**
 * Move a table to another location.
 *
 * `saveTable` deliberately refuses to change a table's branch: it used to
 * overwrite it with the editor's own, silently relocating the table and every
 * order ever taken at it. That guard prevents the accident and leaves no way to
 * correct one — and correcting them is exactly what is needed, because every
 * table in this system was created at the default branch by the bug above.
 *
 * So the move is its own act, with its own guard. Both ends are checked, and a
 * table with an unfinished order does not move: the order would follow the
 * table into a building where nobody is cooking it.
 */
export async function moveTable(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    moveTableSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TABLE_MANAGE)

      const table = await prisma.restaurantTable.findFirst({
        where: { id: data.id, restaurantId: user.restaurantId },
        select: { id: true, number: true, branchId: true },
      })
      if (!table) throw new NotFoundError('Table')

      // Both ends: you may not move a table out of a location you cannot see,
      // nor into one.
      await assertRecordBranch(user, table, 'table')
      await assertBranchAccess(user, data.branchId)

      if (table.branchId === data.branchId) {
        throw new ConflictError('That table is already at this location')
      }

      const destination = await prisma.branch.findFirst({
        where: {
          id: data.branchId,
          restaurantId: user.restaurantId,
          deletedAt: null,
          isActive: true,
          // Guests sit at branches. A warehouse has no dining room.
          type: 'BRANCH',
        },
        select: { id: true, name: true },
      })
      if (!destination) throw new NotFoundError('Location')

      const openOrders = await prisma.order.count({
        where: {
          tableId: table.id,
          restaurantId: user.restaurantId,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
      })
      if (openOrders > 0) {
        throw new ConflictError(
          `Table ${table.number} has ${openOrders} open order${openOrders === 1 ? '' : 's'} — settle or cancel ${openOrders === 1 ? 'it' : 'them'} first.`,
        )
      }

      const clash = await prisma.restaurantTable.findFirst({
        where: { restaurantId: user.restaurantId, branchId: destination.id, number: table.number },
        select: { id: true },
      })
      if (clash) {
        throw new ConflictError(
          `${destination.name} already has a table numbered ${table.number}.`,
        )
      }

      await prisma.restaurantTable.update({
        where: { id: table.id },
        data: { branchId: destination.id },
      })

      revalidatePath('/dashboard/tables')
      revalidatePath('/dashboard/qr')
      return { id: table.id }
    },
    'Table moved.',
  )
}

export async function createTablesBulk(input: unknown): Promise<ActionResult<{ created: number }>> {
  return runAction(
    bulkTablesSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TABLE_MANAGE)

      await assertBranchAccess(user, data.branchId || null)
      // See `saveTable` above for why this is the acting branch and not the
      // caller's home branch.
      const branchId = data.branchId || (await actingBranchId(user))

      // Numbers taken AT THIS BRANCH. Restaurant-wide would refuse to create
      // Kandy's table 1 because Colombo already has one.
      const existing = await prisma.restaurantTable.findMany({
        where: { restaurantId: user.restaurantId, branchId },
        select: { number: true },
      })
      const taken = new Set(existing.map((table) => table.number))

      const rows = Array.from({ length: data.count }, (_, index) => ({
        restaurantId: user.restaurantId,
        branchId,
        number: String(data.startFrom + index),
        capacity: data.capacity,
        area: data.area || 'Main',
        sortOrder: data.startFrom + index,
      })).filter((row) => !taken.has(row.number))

      if (!rows.length) {
        throw new ConflictError('All those table numbers already exist at this location')
      }

      const result = await prisma.restaurantTable.createMany({ data: rows, skipDuplicates: true })
      revalidatePath('/dashboard/tables')
      return { created: result.count }
    },
    'Tables created.',
  )
}

export async function updateTableStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(updateTableStatusSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.TABLE_MANAGE)
    /*
     * Branch-scoped in the `where`, not checked afterwards.
     *
     * These three matched on id + restaurant, so a Branch 01 waiter could flip
     * a Main Branch table to OCCUPIED — or delete it — by posting its id. Using
     * `updateMany` with the branch predicate means another location's table
     * matches nothing and reports as not-found, which is the same answer an
     * invented id gets.
     */
    const reach = visibleBranchIds({ role: user.role, branchId: user.branchId })
    const result = await prisma.restaurantTable.updateMany({
      where: {
        id: data.id,
        restaurantId: user.restaurantId,
        ...(reach ? { branchId: { in: reach } } : {}),
      },
      data: { status: data.status },
    })
    if (result.count === 0) throw new NotFoundError('Table')

    const table = await prisma.restaurantTable.findUnique({ where: { id: data.id }, select: { number: true, branchId: true } })
    realtime.tableUpdated(user.restaurantId, {
      id: data.id, number: table?.number ?? '', status: data.status, branchId: table?.branchId ?? null,
    })
    revalidatePath('/dashboard/tables')
    revalidatePath('/waiter')
    return { id: data.id }
  })
}

/** Waiters seat a walk-in or clear a table from the floor (abc.md §3: Empty / Occupied). */
export async function setServiceTableStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(serviceTableStatusSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.WAITER_VIEW)
    const reach = visibleBranchIds({ role: user.role, branchId: user.branchId })
    const result = await prisma.restaurantTable.updateMany({
      where: {
        id: data.id,
        restaurantId: user.restaurantId,
        ...(reach ? { branchId: { in: reach } } : {}),
      },
      data: { status: data.status },
    })
    if (result.count === 0) throw new NotFoundError('Table')

    const table = await prisma.restaurantTable.findUnique({ where: { id: data.id }, select: { number: true, branchId: true } })
    realtime.tableUpdated(user.restaurantId, {
      id: data.id, number: table?.number ?? '', status: data.status, branchId: table?.branchId ?? null,
    })
    revalidatePath('/waiter')
    revalidatePath('/dashboard/tables')
    return { id: data.id }
  })
}

export async function deleteTable(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.TABLE_MANAGE)

    const openOrders = await prisma.order.count({
      where: { tableId: id, restaurantId: user.restaurantId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    })
    if (openOrders > 0) throw new ConflictError('This table has open orders')

    /*
     * Every sitting the table ever hosted, and every call bell rung from it,
     * used to cascade away with it. `Order.tableNumber` was snapshotted so a
     * deleted table would not erase which table past orders were at; the
     * sitting itself got no such care. The database now refuses (RESTRICT);
     * the screen says why and offers the honest alternative.
     */
    const sittings = await prisma.tableSession.count({
      where: { tableId: id, restaurantId: user.restaurantId },
    })
    if (sittings > 0) {
      throw new ConflictError('This table has seating history — mark it inactive instead of deleting it')
    }

    const reach = visibleBranchIds({ role: user.role, branchId: user.branchId })
    const result = await prisma.restaurantTable.deleteMany({
      where: {
        id,
        restaurantId: user.restaurantId,
        ...(reach ? { branchId: { in: reach } } : {}),
      },
    })
    if (result.count === 0) throw new NotFoundError('Table')

    revalidatePath('/dashboard/tables')
    return { id }
  }, 'Table deleted.')
}

// ── swapping tables (abc.md §3) ──────────────────────────────────────────────

/** Empty, in-service tables at the source's location — where a sitting may move. */
export async function listSwapTargetsAction(
  input: unknown,
): Promise<ActionResult<{ tables: Array<{ id: string; number: string; label: string | null; area: string | null; capacity: number }> }>> {
  return runAction(swapTargetsSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.TABLE_SWAP)
    const source = await prisma.restaurantTable.findFirst({
      where: { id: data.fromTableId, restaurantId: user.restaurantId },
      select: { id: true, branchId: true },
    })
    await assertRecordBranch(user, source, 'table')
    if (!source) throw new NotFoundError('Table')

    const tables = await prisma.restaurantTable.findMany({
      where: { restaurantId: user.restaurantId, branchId: source.branchId, isActive: true, id: { not: source.id } },
      select: {
        id: true, number: true, label: true, area: true, capacity: true,
        _count: { select: { orders: { where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } } } },
      },
      orderBy: [{ area: 'asc' }, { sortOrder: 'asc' }, { number: 'asc' }],
    })
    const states = await tableStatesFor(prisma, {
      restaurantId: user.restaurantId,
      branchId: source.branchId,
      occupiedIds: tables.filter((t) => t._count.orders > 0).map((t) => t.id),
    })
    return {
      tables: tables
        .filter((t) => states.get(t.id)?.state === 'AVAILABLE')
        .map((t) => ({ id: t.id, number: t.number, label: t.label, area: t.area, capacity: t.capacity })),
    }
  })
}

/**
 * Move a sitting to an empty table. The rules live in `swapTable`; this is
 * the guard, the audit row and the news: both tables' states and every moved
 * order go out after commit, so the kitchen, the floor and the till all show
 * the new table at once.
 */
export async function swapTableAction(
  input: unknown,
): Promise<ActionResult<{ fromNumber: string; toNumber: string; movedOrders: number }>> {
  return runAction(
    swapTableSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TABLE_SWAP)
      const source = await prisma.restaurantTable.findFirst({
        where: { id: data.fromTableId, restaurantId: user.restaurantId },
        select: { branchId: true },
      })
      await assertRecordBranch(user, source, 'table')

      const result = await swapTable({
        restaurantId: user.restaurantId,
        fromTableId: data.fromTableId,
        toTableId: data.toTableId,
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: result.from.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.TABLE_SWAPPED,
        entity: 'RestaurantTable',
        entityId: result.from.id,
        before: { table: result.from.number },
        after: { table: result.to.number, orders: result.movedOrderIds, sessionId: result.sessionId },
      })

      realtime.tableUpdated(user.restaurantId, {
        id: result.from.id, number: result.from.number, status: 'AVAILABLE', branchId: result.from.branchId,
      })
      realtime.tableUpdated(user.restaurantId, {
        id: result.to.id, number: result.to.number, status: 'OCCUPIED', branchId: result.to.branchId,
      })
      for (const orderId of result.movedOrderIds) {
        const payload = await toOrderPayload(orderId)
        if (payload) realtime.orderUpdated(user.restaurantId, payload)
      }

      for (const path of ['/dashboard/tables', '/dashboard/live', '/waiter', '/kitchen', '/cashier', '/cashier/pos']) {
        revalidatePath(path)
      }
      return { fromNumber: result.from.number, toNumber: result.to.number, movedOrders: result.movedOrderIds.length }
    },
    'Table swapped.',
  )
}

// ── reservations ─────────────────────────────────────────────────────────────

export async function saveReservation(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    reservationSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.RESERVATION_MANAGE)

      /*
       * ── Which location this booking is for ────────────────────────────────
       *
       * The table decides it where one is chosen, because a table belongs to
       * exactly one site — and that is also the check that stops a Kandy
       * manager seating a guest at a Colombo table. The picker used to offer
       * every branch's tables with nothing to tell them apart, since table
       * numbers restart per branch by design.
       *
       * With no table yet — a phone booking for "sometime Friday" — it falls to
       * the branch on screen, which is what `actingBranchId` reads.
       */
      /*
       * The booking being edited must be this restaurant's, at a branch this
       * person reaches — the same two checks the table branch of this file
       * applies. The update by primary key alone let a Kandy manager cancel
       * a Colombo booking, and with a foreign id rewrite another restaurant's
       * booking onto this restaurant's branch and table.
       */
      const existing = data.id
        ? await prisma.reservation.findFirst({
            where: { id: data.id, restaurantId: user.restaurantId },
            select: { id: true, branchId: true },
          })
        : null
      if (data.id && !existing) throw new NotFoundError('Reservation')
      if (existing) await assertRecordBranch(user, existing, 'reservation')

      let branchId: string | null = null

      if (data.tableId) {
        const table = await prisma.restaurantTable.findFirst({
          where: { id: data.tableId, restaurantId: user.restaurantId },
          select: { id: true, branchId: true },
        })
        if (!table) throw new NotFoundError('Table')
        await assertBranchAccess(user, table.branchId)
        branchId = table.branchId
      } else if (existing) {
        // No table chosen on an edit: the booking stays where it was booked,
        // never re-homed to whichever branch the editor happens to be on.
        branchId = existing.branchId
      } else {
        branchId = await actingBranchId(user)
      }

      // The rules — end time, capacity, no two bookings holding one table at
      // once — live in `upsertReservation` (abc.md §4), under a lock on the
      // table's row so two hosts booking the same slot are serialised.
      const record = await upsertReservation({
        restaurantId: user.restaurantId,
        id: existing?.id ?? null,
        data: {
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          customerEmail: data.customerEmail || null,
          tableId: data.tableId || null,
          branchId,
          partySize: data.partySize,
          reservedAt: new Date(data.reservedAt),
          durationMinutes: data.durationMinutes,
          status: data.status,
          notes: data.notes || null,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: data.id ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE,
        entity: 'Reservation',
        entityId: record.id,
      })

      revalidatePath('/dashboard/reservations')
      return { id: record.id }
    },
    'Reservation saved.',
  )
}

export async function deleteReservation(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.RESERVATION_MANAGE)
    const result = await prisma.reservation.deleteMany({
      where: { id, restaurantId: user.restaurantId },
    })
    if (result.count === 0) throw new NotFoundError('Reservation')
    revalidatePath('/dashboard/reservations')
    return { id }
  }, 'Reservation removed.')
}

// ── a colleague calls a waiter to a table (abc.md §7) ───────────────────────

/**
 * From the till, the KDS, the live floor or the tables page: "somebody go
 * to table 4". Same door as the guest's button, so the duplicate rule, the
 * popup, the bell and the history are one thing. Gated on ORDER_VIEW —
 * everybody on the floor stack holds it — and scoped to the table's site.
 */
export async function callWaiterAction(
  input: unknown,
): Promise<ActionResult<{ id: string; created: boolean; tableNumber: string }>> {
  return runAction(callWaiterSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ORDER_VIEW)
    const table = await prisma.restaurantTable.findFirst({
      where: { id: data.tableId, restaurantId: user.restaurantId },
      select: { id: true, number: true, branchId: true },
    })
    if (!table) throw new NotFoundError('Table')
    await assertRecordBranch(user, table, 'table')

    const { request, created } = await openServiceRequest({
      restaurantId: user.restaurantId,
      tableId: table.id,
      type: 'CALL_WAITER',
      note: data.note || null,
      requestedByName: user.name,
      createdById: user.id,
    })
    if (created) {
      await audit({
        restaurantId: user.restaurantId,
        branchId: table.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SERVICE_REQUEST_CREATED,
        entity: 'ServiceRequest',
        entityId: request.id,
        after: { table: table.number, type: 'CALL_WAITER', note: data.note || null },
      })
    }
    revalidatePath('/waiter')
    revalidatePath('/dashboard/live')
    return { id: request.id, created, tableNumber: table.number }
  })
}
