'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
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
      const branchId = await resolveBranchId({
        restaurantId: user.restaurantId,
        requestedBranchId: data.branchId || null,
        userBranchId: user.branchId,
      })

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

export async function createTablesBulk(input: unknown): Promise<ActionResult<{ created: number }>> {
  return runAction(
    bulkTablesSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TABLE_MANAGE)

      await assertBranchAccess(user, data.branchId || null)
      const branchId = await resolveBranchId({
        restaurantId: user.restaurantId,
        requestedBranchId: data.branchId || null,
        userBranchId: user.branchId,
      })

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

    realtime.tableUpdated(user.restaurantId, { id: data.id, number: '', status: data.status })
    revalidatePath('/dashboard/tables')
    revalidatePath('/waiter')
    return { id: data.id }
  })
}

/** Waiters set the everyday table status (Empty / Ordering / Eating / etc.). */
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

    realtime.tableUpdated(user.restaurantId, { id: data.id, number: '', status: data.status })
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

// ── reservations ─────────────────────────────────────────────────────────────

export async function saveReservation(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    reservationSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.RESERVATION_MANAGE)

      if (data.tableId) {
        const table = await prisma.restaurantTable.findFirst({
          where: { id: data.tableId, restaurantId: user.restaurantId },
          select: { id: true },
        })
        if (!table) throw new NotFoundError('Table')
      }

      const payload = {
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail || null,
        tableId: data.tableId || null,
        partySize: data.partySize,
        reservedAt: new Date(data.reservedAt),
        durationMinutes: data.durationMinutes,
        status: data.status,
        notes: data.notes || null,
      }

      const record = data.id
        ? await prisma.reservation.update({
            where: { id: data.id },
            data: payload,
          })
        : await prisma.reservation.create({ data: { ...payload, restaurantId: user.restaurantId } })

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
