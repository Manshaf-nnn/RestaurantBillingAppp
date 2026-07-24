'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { isUniqueViolation, prisma } from '@/server/db/prisma'
import { realtime } from '@/server/realtime/emitter'
import {
  bulkTablesSchema,
  reservationSchema,
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
      const payload = {
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
          record = await prisma.restaurantTable.update({ where: { id: data.id }, data: payload })
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
        if (isUniqueViolation(error)) throw new ConflictError(`Table ${data.number} already exists`)
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

      const existing = await prisma.restaurantTable.findMany({
        where: { restaurantId: user.restaurantId },
        select: { number: true },
      })
      const taken = new Set(existing.map((table) => table.number))

      const rows = Array.from({ length: data.count }, (_, index) => ({
        restaurantId: user.restaurantId,
        number: String(data.startFrom + index),
        capacity: data.capacity,
        area: data.area || 'Main',
        sortOrder: data.startFrom + index,
      })).filter((row) => !taken.has(row.number))

      if (!rows.length) throw new ConflictError('All those table numbers already exist')

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
    const result = await prisma.restaurantTable.updateMany({
      where: { id: data.id, restaurantId: user.restaurantId },
      data: { status: data.status },
    })
    if (result.count === 0) throw new NotFoundError('Table')

    realtime.tableUpdated(user.restaurantId, { id: data.id, number: '', status: data.status })
    revalidatePath('/dashboard/tables')
    revalidatePath('/waiter')
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

    const result = await prisma.restaurantTable.deleteMany({
      where: { id, restaurantId: user.restaurantId },
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
