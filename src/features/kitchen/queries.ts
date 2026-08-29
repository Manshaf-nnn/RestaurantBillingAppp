import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * One section's own work.
 *
 * ── Item-first, and scoped in SQL ───────────────────────────────────────────
 *
 * The main kitchen rail is order-first: a card per ticket with every dish on
 * it. A section must see the opposite — only the dishes it cooks, and never the
 * rest of the order. A pizza cook has no business reading the table's drinks
 * order, and §6 says so explicitly.
 *
 * The branch is in the `where`, not applied afterwards in the browser. §2 is
 * blunt about that: filtering on the client would mean the other branch's
 * dishes were on the wire, one devtools panel away, and any future caller of
 * this query would inherit the hole.
 */

export interface StationTicketItem {
  id: string
  orderId: string
  orderNumber: string
  tableNumber: string | null
  /** Where the order came from, for a takeaway with no table. */
  orderType: string
  name: string
  quantity: number
  notes: string | null
  isVeg: boolean
  status: string
  optionsLabel: string
  priority: string
  /** When this dish reached the section — the clock a cook is judged on. */
  routedAt: string | null
  preparingAt: string | null
  /** A later round on a table that already has food. §10's "new addition". */
  isAddition: boolean
}

export async function getStationQueue(params: {
  restaurantId: string
  branchId: string
  stationId: string
}): Promise<StationTicketItem[]> {
  const items = await prisma.orderItem.findMany({
    where: {
      stationId: params.stationId,
      status: { in: ['QUEUED', 'PREPARING', 'READY'] },
      order: {
        restaurantId: params.restaurantId,
        // In the query. Never trust a station id from a URL to imply a branch.
        branchId: params.branchId,
        status: { in: ['ACCEPTED', 'PREPARING', 'READY'] },
      },
    },
    select: {
      id: true,
      orderId: true,
      name: true,
      quantity: true,
      notes: true,
      isVeg: true,
      status: true,
      options: true,
      routedAt: true,
      preparingAt: true,
      order: {
        select: {
          orderNumber: true,
          tableNumber: true,
          tableId: true,
          type: true,
          priority: true,
          placedAt: true,
        },
      },
    },
    // Urgent first, then whoever has waited longest. §15's default.
    orderBy: [{ order: { priority: 'desc' } }, { routedAt: 'asc' }, { createdAt: 'asc' }],
    take: 200,
  })

  /*
   * Which of these belong to a later round at a table that already had food.
   *
   * One query for the whole page rather than one per ticket: gather the tables
   * involved, then ask which of them have an earlier open order.
   */
  const tableIds = [...new Set(items.map((i) => i.order.tableId).filter((id): id is string => Boolean(id)))]
  const earlier = tableIds.length
    ? await prisma.order.groupBy({
        by: ['tableId'],
        where: {
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          tableId: { in: tableIds },
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
        _min: { placedAt: true },
      })
    : []
  const firstAtTable = new Map(earlier.map((row) => [row.tableId, row._min.placedAt]))

  return items.map((item) => {
    const first = item.order.tableId ? firstAtTable.get(item.order.tableId) : null
    return {
      id: item.id,
      orderId: item.orderId,
      orderNumber: item.order.orderNumber,
      tableNumber: item.order.tableNumber,
      orderType: item.order.type as string,
      name: item.name,
      quantity: item.quantity,
      notes: item.notes,
      isVeg: item.isVeg,
      status: item.status as string,
      optionsLabel: readOptionNames(item.options).join(' · '),
      priority: item.order.priority as string,
      routedAt: item.routedAt?.toISOString() ?? null,
      preparingAt: item.preparingAt?.toISOString() ?? null,
      isAddition: Boolean(first && item.order.placedAt.getTime() > first.getTime()),
    }
  })
}

/** How much each section is carrying, for the supervisor's overview. */
export async function getStationWorkload(params: {
  restaurantId: string
  branchId: string
}): Promise<Array<{ stationId: string; name: string; queued: number; preparing: number; ready: number }>> {
  const stations = await prisma.kitchenStation.findMany({
    where: { restaurantId: params.restaurantId, branchId: params.branchId, isActive: true },
    select: { id: true, name: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  if (stations.length === 0) return []

  const counts = await prisma.orderItem.groupBy({
    by: ['stationId', 'status'],
    where: {
      stationId: { in: stations.map((s) => s.id) },
      status: { in: ['QUEUED', 'PREPARING', 'READY'] },
      order: { status: { in: ['ACCEPTED', 'PREPARING', 'READY'] } },
    },
    // Quantities, not row counts — three of one dish is three plates of work.
    _sum: { quantity: true },
  })

  return stations.map((station) => {
    const at = (status: string) =>
      counts.find((row) => row.stationId === station.id && row.status === status)?._sum.quantity ?? 0
    return {
      stationId: station.id,
      name: station.name,
      queued: at('QUEUED'),
      preparing: at('PREPARING'),
      ready: at('READY'),
    }
  })
}

/** The option snapshot on a line, as plain names. */
function readOptionNames(options: unknown): string[] {
  const list = (options as Array<{ name?: string }> | null) ?? []
  if (!Array.isArray(list)) return []
  return list.map((option) => option?.name).filter((name): name is string => Boolean(name))
}
