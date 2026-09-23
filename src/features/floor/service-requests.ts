import 'server-only'

import type { Prisma, ServiceRequest, ServiceRequestType } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { isUniqueViolation, prisma } from '@/server/db/prisma'
import { notifyAudiences } from '@/server/notifications'
import { realtime } from '@/server/realtime/emitter'
import { emitOutbox } from '@/server/realtime/outbox'

/**
 * A guest — or a colleague on their behalf — calling the floor (abc.md §7).
 *
 * ── One event per table and need ────────────────────────────────────────────
 *
 * `service_requests` carries a partial unique index on `(tableId, type)
 * WHERE status <> 'RESOLVED'`. That index IS the duplicate rule: a second
 * "call waiter" from the same table while the first is open or acknowledged
 * does not make a second row, whoever sends it and however fast. The old
 * code compared timestamps inside a three-minute window, which two taps a
 * few milliseconds apart sailed straight through. Here the database refuses
 * and the caller gets the row that already exists.
 *
 * ── What the row says ───────────────────────────────────────────────────────
 *
 * Restaurant, branch (from the table, stored so the waiter's queue and the
 * history can filter without a join), table, who called (the table itself,
 * or the colleague's name), when it was acknowledged and by whom, when it
 * was resolved and by whom. Every state change goes to the waiter and
 * management rooms and to the bell; the acknowledgement stops other stations
 * from running to a table somebody is already walking to.
 */

export const ACTIVE_STATUSES = ['OPEN', 'ACKNOWLEDGED'] as const

export const REQUEST_LABEL: Record<ServiceRequestType, string> = {
  CALL_WAITER: 'Calling a waiter',
  WATER: 'Water',
  PLATES: 'Extra plates',
  BILL: 'Bill requested',
  HELP: 'Needs help',
  CLEAN_TABLE: 'Clean table',
}

export interface OpenedServiceRequest {
  request: ServiceRequest & { table: { id: string; number: string; branchId: string } }
  /** False when an active call for this table and need already existed. */
  created: boolean
}

export async function openServiceRequest(params: {
  restaurantId: string
  tableId: string
  type: ServiceRequestType
  note?: string | null
  /** Who is calling: "Table 4" for a guest, the colleague's name for staff. */
  requestedByName?: string | null
  createdById?: string | null
}): Promise<OpenedServiceRequest> {
  const table = await prisma.restaurantTable.findFirst({
    where: { id: params.tableId, restaurantId: params.restaurantId, isActive: true },
    select: { id: true, number: true, branchId: true },
  })
  if (!table) throw new NotFoundError('Table')

  const requestedByName = params.requestedByName?.trim() || `Table ${table.number}`
  const note = params.note?.trim() || null

  let request: ServiceRequest
  let created = false
  try {
    /*
     * The row and its outbox entry commit together (pro.A.md §16).
     *
     * A waiter call was the one important event with no durable record of
     * having happened: the socket emit below is fire-and-forget, so a station
     * whose tablet was reconnecting at that moment simply never learned about
     * it, and there was nothing to replay. Now the event is in the same
     * transaction as the request, so a screen coming back can catch up.
     */
    request = await prisma.$transaction(async (tx) => {
      const row = await tx.serviceRequest.create({
        data: {
          restaurantId: params.restaurantId,
          branchId: table.branchId,
          tableId: table.id,
          type: params.type,
          note,
          requestedByName,
          createdById: params.createdById ?? null,
        },
      })
      await emitOutbox(tx, {
        restaurantId: params.restaurantId,
        branchId: table.branchId,
        type: 'service-request.created',
        entity: 'ServiceRequest',
        entityId: row.id,
        payload: { tableId: table.id, tableNumber: table.number, type: row.type },
      })
      return row
    })
    created = true
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    // The index refused: somebody at this table already asked for this.
    const existing = await prisma.serviceRequest.findFirst({
      where: {
        restaurantId: params.restaurantId,
        tableId: table.id,
        type: params.type,
        status: { in: [...ACTIVE_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (!existing) throw error
    request = existing
  }

  if (created) {
    realtime.serviceRequest(params.restaurantId, {
      id: request.id,
      tableId: table.id,
      branchId: table.branchId,
      tableNumber: table.number,
      type: request.type,
      note: request.note,
      createdAt: request.createdAt.toISOString(),
      requestedByName,
      status: request.status,
    })
    await notifyAudiences(['WAITER', 'MANAGEMENT'], {
      restaurantId: params.restaurantId,
      branchId: table.branchId,
      type: 'SERVICE_REQUEST',
      title:
        params.type === 'CALL_WAITER'
          ? `Table ${table.number} is calling a waiter`
          : `Table ${table.number} needs ${REQUEST_LABEL[params.type].toLowerCase()}`,
      body: [requestedByName !== `Table ${table.number}` ? `Called by ${requestedByName}` : null, note]
        .filter(Boolean)
        .join(' · ') || null,
      data: { tableId: table.id, tableNumber: table.number, requestId: request.id, type: params.type },
    })
  }

  return { request: { ...request, table }, created }
}

async function loadRequest(restaurantId: string, requestId: string) {
  const request = await prisma.serviceRequest.findFirst({
    where: { id: requestId, restaurantId },
    include: { table: { select: { id: true, number: true, branchId: true } } },
  })
  if (!request) throw new NotFoundError('Request')
  return request
}

/** "I am on my way": stops every other station running to the same table. */
export async function acknowledgeServiceRequest(params: {
  restaurantId: string
  requestId: string
  userId: string
  userName: string
}) {
  const request = await loadRequest(params.restaurantId, params.requestId)
  if (request.status === 'RESOLVED') {
    throw new AppError('This request was already resolved', 409, 'REQUEST_RESOLVED')
  }
  if (request.status === 'ACKNOWLEDGED') return request

  const updated = await prisma.serviceRequest.update({
    where: { id: request.id },
    data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedById: params.userId },
    include: { table: { select: { id: true, number: true, branchId: true } } },
  })
  realtime.serviceRequestAcknowledged(params.restaurantId, {
    id: updated.id,
    branchId: updated.table.branchId,
    acknowledgedByName: params.userName,
    acknowledgedAt: updated.acknowledgedAt?.toISOString() ?? new Date().toISOString(),
  })
  return updated
}

/** Done: the table has been seen to. Idempotent. */
export async function resolveServiceRequestRecord(params: {
  restaurantId: string
  requestId: string
  userId: string
}) {
  const request = await loadRequest(params.restaurantId, params.requestId)
  if (request.status === 'RESOLVED') return request

  const updated = await prisma.serviceRequest.update({
    where: { id: request.id },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      handledById: params.userId,
      // Resolving without acknowledging first still records who came.
      ...(request.acknowledgedAt === null
        ? { acknowledgedAt: new Date(), acknowledgedById: params.userId }
        : {}),
    },
    include: { table: { select: { id: true, number: true, branchId: true } } },
  })
  realtime.serviceRequestResolved(params.restaurantId, updated.id)
  return updated
}

export interface ServiceRequestHistoryRow {
  id: string
  tableId: string
  tableNumber: string
  branchId: string | null
  type: ServiceRequestType
  status: ServiceRequest['status']
  note: string | null
  requestedByName: string | null
  createdAt: Date
  acknowledgedAt: Date | null
  acknowledgedByName: string | null
  resolvedAt: Date | null
  handledByName: string | null
}

/**
 * Waiter calls over a period, newest first, for the history card.
 *
 * `branchIds` follows the house convention: null is every location, an array
 * narrows, an empty array returns nothing.
 */
export async function listServiceRequests(params: {
  restaurantId: string
  branchIds: string[] | null
  range: { start: Date; end: Date }
  take?: number
}): Promise<ServiceRequestHistoryRow[]> {
  const where: Prisma.ServiceRequestWhereInput = {
    restaurantId: params.restaurantId,
    createdAt: { gte: params.range.start, lt: params.range.end },
    ...(params.branchIds ? { table: { branchId: { in: params.branchIds } } } : {}),
  }
  const rows = await prisma.serviceRequest.findMany({
    where,
    include: {
      table: { select: { id: true, number: true, branchId: true } },
      acknowledgedBy: { select: { name: true } },
      handledBy: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: params.take ?? 200,
  })
  return rows.map((row) => ({
    id: row.id,
    tableId: row.tableId,
    tableNumber: row.table.number,
    branchId: row.branchId ?? row.table.branchId,
    type: row.type,
    status: row.status,
    note: row.note,
    requestedByName: row.requestedByName,
    createdAt: row.createdAt,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedByName: row.acknowledgedBy?.name ?? null,
    resolvedAt: row.resolvedAt,
    handledByName: row.handledBy?.name ?? null,
  }))
}
