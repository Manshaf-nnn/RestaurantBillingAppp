import type { Metadata } from 'next'

import { CashierBoard } from '@/features/cashier/components/cashier-board'
import { readPaperWidths } from '@/features/printing/paper'
import { getPublicMenu } from '@/features/menu/queries'
import { getCashierQueue, readOptions } from '@/features/orders/queries'
import { PERMISSIONS, ROLE_LABELS } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Cashier' }

export default async function CashierPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PAYMENT_COLLECT, '/cashier')

  // The sidebar's "Takeaway" entry links here with ?mode=takeaway. It used to
  // be ignored, so that link just opened the ordinary cashier screen.
  const params = await searchParams
  const startInTakeaway = params.mode === 'takeaway'

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const restaurant = await requireRestaurant(user.restaurantId)

  /*
   * Which locations this screen shows — see the note on the kitchen page. A
   * floor screen belongs to the room it is standing in.
   */
  const { branchIds } = await selectedBranch(user, params)

  const [menu, bills, today] = await Promise.all([
    // The till sells its own branch's menu at its own branch's prices. A
    // cashier confined to Kandy must not be able to ring up a Colombo-only
    // dish, and must never charge Colombo's price for a shared one.
    getPublicMenu(user.restaurantId, restaurant.timezone, user.branchId),
    getCashierQueue(user.restaurantId, branchIds),
    prisma.payment.aggregate({
      where: {
        restaurantId: user.restaurantId,
        status: 'PAID',
        paidAt: { gte: startOfDay },
        // A payment has no branch of its own — it reaches one through its
        // order, whose branch is required. Without this the till's "taken
        // today" was the whole chain's takings.
        ...(branchIds ? { order: { branchId: { in: branchIds } } } : {}),
      },
      _sum: { amount: true },
      _count: true,
    }),
  ])

  return (
    <CashierBoard
      menu={menu}
      startInTakeaway={startInTakeaway}
      user={{ name: user.name, role: ROLE_LABELS[user.role] }}
      todayTotal={today._sum.amount ?? 0}
      todayCount={today._count}
      restaurant={{
        name: restaurant.name,
        currency: restaurant.currency,
        locale: restaurant.locale === 'en' ? 'en-IN' : restaurant.locale,
        taxLabel: restaurant.taxLabel,
        // Paper size the owner chose in Settings — receipts printed at the wrong
        // width waste a third of an 80 mm roll, or overflow a 58 mm one.
        paper: readPaperWidths(restaurant.printerConfig),
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
        heldAt: order.heldAt ? order.heldAt.toISOString() : null,
        holdReason: order.holdReason,
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
