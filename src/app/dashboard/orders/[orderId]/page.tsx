import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { readPaperWidths } from '@/features/printing/paper'
import { OrderDetail } from '@/features/orders/components/order-detail'
import { getOrderForStaff, readOptions } from '@/features/orders/queries'
import { can, canAccessBranch, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Order details' }

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>
}) {
  const { orderId } = await params
  const user = await requirePagePermission(PERMISSIONS.ORDER_VIEW, '/dashboard/orders')

  const [restaurant, order] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getOrderForStaff(user.restaurantId, orderId),
  ])

  if (!order) notFound()

  /*
   * Another branch's order is not this person's to read.
   *
   * `Order.branchId` has been on the record the whole time and this page never
   * looked at it — so a Kandy manager pasting a Colombo order id got the
   * customer, the totals and the payments.
   */
  if (order.branchId && !canAccessBranch(user, order.branchId)) notFound()

  return (
    <OrderDetail
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      restaurant={{
        name: restaurant.name,
        addressLine: [restaurant.addressLine, restaurant.city].filter(Boolean).join(', ') || null,
        phone: restaurant.phone,
        // The owner's chosen thermal width. This screen used to print 58mm
        // regardless, because it called printReceipt without one.
        paper: readPaperWidths(restaurant.printerConfig),
      }}
      canUpdate={can(user, PERMISSIONS.ORDER_UPDATE_STATUS)}
      canCancel={can(user, PERMISSIONS.ORDER_CANCEL)}
      order={{
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        type: order.type,
        tableNumber: order.tableNumber ?? order.table?.number ?? null,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerEmail: order.customerEmail,
        notes: order.notes,
        cancelReason: order.cancelReason,
        placedAt: order.placedAt.toISOString(),
        subtotal: order.subtotal,
        discountTotal: order.discountTotal,
        loyaltyDiscount: order.loyaltyDiscount,
        serviceCharge: order.serviceCharge,
        taxTotal: order.taxTotal,
        tipAmount: order.tipAmount,
        roundingAdj: order.roundingAdj,
        grandTotal: order.grandTotal,
        paidTotal: order.paidTotal,
        taxLabel: restaurant.taxLabel,
        items: order.items.map((item) => ({
          id: item.id,
          name: item.name,
          optionsLabel: readOptions(item.options).map((option) => option.name).join(', '),
          quantity: item.quantity,
          lineTotal: item.lineTotal,
          notes: item.notes,
          isVeg: item.isVeg,
          status: item.status,
        })),
        events: order.events.map((event) => ({
          id: event.id,
          status: event.status,
          note: event.note,
          actorName: event.actorName,
          createdAt: event.createdAt.toISOString(),
        })),
        payments: order.payments.map((payment) => ({
          id: payment.id,
          method: payment.method,
          amount: payment.amount,
          status: payment.status,
          createdAt: payment.createdAt.toISOString(),
        })),
      }}
    />
  )
}
