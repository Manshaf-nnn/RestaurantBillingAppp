import type { Metadata } from 'next'

import { ReservationsManager } from '@/features/floor/components/reservations-manager'
import { PERMISSIONS } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
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
  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)

  const [restaurant, reservations, tables] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.reservation.findMany({
      where: {
        restaurantId: user.restaurantId,
        /*
         * A booking with no branch is one taken before this column existed and
         * with no table to infer from. It stays visible to whoever can see
         * everything, and is hidden from a single branch rather than being
         * claimed by one of them.
         */
        ...(selection.branchIds ? { branchId: { in: selection.branchIds } } : {}),
      },
      orderBy: { reservedAt: 'desc' },
      take: 200,
      include: { table: { select: { number: true } }, branch: { select: { name: true } } },
    }),
    prisma.restaurantTable.findMany({
      where: {
        restaurantId: user.restaurantId,
        isActive: true,
        ...(selection.branchIds ? { branchId: { in: selection.branchIds } } : {}),
      },
      select: { id: true, number: true, branch: { select: { name: true } } },
      orderBy: { number: 'asc' },
    }),
  ])

  return (
    <ReservationsManager
      locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
      /*
       * The branch label is only worth showing when the list spans more than
       * one — on a single-site restaurant it is noise on every row.
       */
      tables={tables.map((t) => ({
        id: t.id,
        number: t.number,
        branchName:
          new Set(tables.map((x) => x.branch?.name)).size > 1 ? (t.branch?.name ?? null) : null,
      }))}
      reservations={reservations.map((reservation) => ({
        id: reservation.id,
        customerName: reservation.customerName,
        customerPhone: reservation.customerPhone,
        partySize: reservation.partySize,
        reservedAt: reservation.reservedAt.toISOString(),
        tableNumber: reservation.table?.number ?? null,
        status: reservation.status,
        notes: reservation.notes,
      }))}
    />
  )
}
