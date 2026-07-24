import type { Metadata } from 'next'

import { ReservationsManager } from '@/features/floor/components/reservations-manager'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Reservations' }

export default async function ReservationsPage() {
  const user = await requirePagePermission(PERMISSIONS.RESERVATION_MANAGE, '/dashboard/reservations')
  const [restaurant, reservations, tables] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.reservation.findMany({
      where: { restaurantId: user.restaurantId },
      orderBy: { reservedAt: 'desc' },
      take: 200,
      include: { table: { select: { number: true } } },
    }),
    prisma.restaurantTable.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    }),
  ])

  return (
    <ReservationsManager
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      tables={tables}
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
