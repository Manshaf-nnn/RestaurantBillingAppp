import type { Metadata } from 'next'

import { CashierBoard } from '@/features/cashier/components/cashier-board'
import { getCashierQueue, readOptions } from '@/features/orders/queries'
import { PERMISSIONS, ROLE_LABELS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Cashier' }

export default async function CashierPage() {
  const user = await requirePagePermission(PERMISSIONS.PAYMENT_COLLECT, '/cashier')

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const [restaurant, bills, today] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getCashierQueue(user.restaurantId),
    prisma.payment.aggregate({
      where: {
        restaurantId: user.restaurantId,
        status: 'PAID',
        paidAt: { gte: startOfDay },
      },
      _sum: { amount: true },
      _count: true,
    }),
  ])

  return (
    <CashierBoard
      user={{ name: user.name, role: ROLE_LABELS[user.role] }}
      todayTotal={today._sum.amount ?? 0}
      todayCount={today._count}
      restaurant={{
        name: restaurant.name,
        currency: restaurant.currency,
        locale: restaurant.locale === 'en' ? 'en-IN' : restaurant.locale,
        taxLabel: restaurant.taxLabel,
        addressLine: [restaurant.addressLine, restaurant.city].filter(Boolean).join(', ') || null,
        phone: restaurant.phone,
      }}
      initialBills={bills.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        type: order.type as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
        status: order.status as 'PENDING',
        paymentStatus: order.paymentStatus,
        tableNumber: order.table?.number ?? null,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        placedAt: order.placedAt.toISOString(),
        subtotal: order.subtotal,
        discountTotal: order.discountTotal + order.loyaltyDiscount,
        serviceCharge: order.serviceCharge,
        taxTotal: order.taxTotal,
        grandTotal: order.grandTotal,
        paidTotal: order.paidTotal,
        items: order.items.map((item) => ({
          id: item.id,
          name: item.name,
          optionsLabel: readOptions(item.options)
            .map((option) => option.name)
            .join(', '),
          quantity: item.quantity,
          lineTotal: item.lineTotal,
        })),
      }))}
    />
  )
}
