import type { Metadata } from 'next'

import { ReservationsManager } from '@/features/floor/components/reservations-manager'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { resolveRange, type RangePreset } from '@/features/reports/range'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { reservationsHolding } from '@/features/floor/table-state-server'
import { requireRestaurant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Reservations' }

export default async function ReservationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.RESERVATION_MANAGE, '/dashboard/reservations')

  /*
   * A booking is for a place. This page filtered on the restaurant alone, so a
   * branch manager read the whole group's diary — and the table picker below
   * was worse: no branch filter at all, and table numbers restart per branch by
   * design, so it offered several indistinguishable "Table 4" rows and would
   * happily seat a Kandy guest at a Colombo table.
   */
  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)
  const restaurant = await requireRestaurant(user.restaurantId)

  /*
   * A date range (abc.md §4), in the one vocabulary every report screen
   * uses — `?preset=`, `?from=`, `?to=` — in the restaurant's own timezone.
   * The diary opens on this week: tonight's bookings and the next few days
   * are what a host reads; last month's are one click away.
   */
  const range = resolveRange({
    preset: (typeof params.preset === 'string' ? params.preset : 'THIS_WEEK') as RangePreset,
    from: typeof params.from === 'string' ? params.from : undefined,
    to: typeof params.to === 'string' ? params.to : undefined,
    timeZone: restaurant.timezone,
  })
  /*
   * A diary looks forward. "This week" is week-to-date for the reports, which
   * ends today — so tomorrow's bookings were missing from the list, and the
   * held-table cards above had no row behind them. Here it runs to Sunday.
   */
  const listTo = range.preset === 'THIS_WEEK' ? new Date(range.from.getTime() + 7 * 86_400_000 - 1) : range.to

  const [reservations, tables, locations, holding] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        restaurantId: user.restaurantId,
        reservedAt: { gte: range.from, lte: listTo },
        /*
         * A booking with no branch is one taken before this column existed and
         * with no table to infer from. It stays visible to whoever can see
         * everything, and is hidden from a single branch rather than being
         * claimed by one of them.
         */
        ...(selection.branchIds ? { branchId: { in: selection.branchIds } } : {}),
      },
      orderBy: { reservedAt: 'asc' },
      take: 500,
      include: { table: { select: { number: true } }, branch: { select: { name: true } } },
    }),
    prisma.restaurantTable.findMany({
      where: {
        restaurantId: user.restaurantId,
        isActive: true,
        ...(selection.branchIds ? { branchId: { in: selection.branchIds } } : {}),
      },
      select: { id: true, number: true, capacity: true, branch: { select: { name: true } } },
      orderBy: { number: 'asc' },
    }),
    listSwitchableLocations(user.restaurantId, visibleBranchIds(user)),
    /*
     * Which tables are spoken for at this moment, by the same rule the
     * tables screen and the live floor use — so the host's panel and the
     * floor plan never disagree about a table.
     */
    reservationsHolding(prisma, { restaurantId: user.restaurantId, branchId: branchId ?? undefined }),
  ])

  /*
   * Every held table's booking, whatever range the list shows. The cards
   * above the list act on the booking itself — Details, Cancel, text the
   * guest — so a card whose booking fell outside the range had dead buttons.
   */
  const listed = new Set(reservations.map((r) => r.id))
  const heldIds = [...holding.values()].map((h) => h.id).filter((id) => !listed.has(id))
  const heldOnly = heldIds.length
    ? await prisma.reservation.findMany({
        where: { id: { in: heldIds }, restaurantId: user.restaurantId },
        include: { table: { select: { number: true } }, branch: { select: { name: true } } },
      })
    : []
  const toRow = (reservation: (typeof reservations)[number]) => ({
    id: reservation.id,
    customerName: reservation.customerName,
    customerPhone: reservation.customerPhone,
    customerEmail: reservation.customerEmail,
    partySize: reservation.partySize,
    reservedAt: reservation.reservedAt.toISOString(),
    endsAt: (reservation.endsAt ?? new Date(reservation.reservedAt.getTime() + reservation.durationMinutes * 60_000)).toISOString(),
    durationMinutes: reservation.durationMinutes,
    tableId: reservation.tableId,
    tableNumber: reservation.table?.number ?? null,
    branchName: reservation.branch?.name ?? null,
    status: reservation.status,
    notes: reservation.notes,
    createdAt: reservation.createdAt.toISOString(),
    cancelledAt: reservation.cancelledAt?.toISOString() ?? null,
    cancelReason: reservation.cancelReason,
    cancelledByName: reservation.cancelledByName,
    noShowAfterMinutes: reservation.noShowAfterMinutes,
  })

  return (
    <>
    <ReportFilters
      preset={range.preset}
      from={range.from.toISOString().slice(0, 10)}
      to={range.to.toISOString().slice(0, 10)}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      branchId={branchId ?? ''}
    />
    <ReservationsManager
      locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
      tableCount={tables.length}
      reservedTables={tables
        .filter((t) => holding.has(t.id))
        .map((t) => {
          const held = holding.get(t.id)!
          return {
            tableId: t.id,
            number: t.number,
            capacity: t.capacity,
            branchName: new Set(tables.map((x) => x.branch?.name)).size > 1 ? (t.branch?.name ?? null) : null,
            reservationId: held.id,
            customerName: held.customerName,
            partySize: held.partySize,
            reservedAt: held.reservedAt.toISOString(),
            endsAt: held.endsAt.toISOString(),
          }
        })}
      /*
       * The branch label is only worth showing when the list spans more than
       * one — on a single-site restaurant it is noise on every row.
       */
      tables={tables.map((t) => ({
        id: t.id,
        number: t.number,
        capacity: t.capacity,
        branchName:
          new Set(tables.map((x) => x.branch?.name)).size > 1 ? (t.branch?.name ?? null) : null,
      }))}
      reservations={reservations.map(toRow)}
      heldBookings={heldOnly.map(toRow)}
    />
    </>
  )
}
