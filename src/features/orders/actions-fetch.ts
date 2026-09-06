'use server'

import { runSafe } from '@/lib/action'
import { NotFoundError } from '@/lib/errors'
import { PERMISSIONS, canAccessBranch } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { readPaperWidths } from '@/features/printing/paper'
import { getOrderForStaff, readOptions } from './queries'
import type { OrderDetailView } from './components/order-detail'
import { localeForCurrency } from '@/lib/money'

/**
 * One order, for a screen that wants to show it without navigating away.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * `getOrderForStaff` is `server-only`, so a client component cannot reach it;
 * and it checks neither permission nor branch — the order detail PAGE does that
 * itself. Anything else wanting an order has to repeat both, which is exactly
 * how the check gets forgotten. This is the one place that repeat lives.
 *
 * ── Read-only is a property of this endpoint ────────────────────────────────
 *
 * `canUpdate` and `canCancel` come back false, always. The live board opens
 * this in a modal over a floor plan that repaints every second, and a
 * mis-tapped "cancel order" there is somebody's dinner. Deciding it here rather
 * than at the call site means a second caller cannot accidentally get buttons.
 */
export async function fetchOrderDetail(orderId: string) {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.ORDER_VIEW)

    const [restaurant, order] = await Promise.all([
      requireRestaurant(user.restaurantId),
      getOrderForStaff(user.restaurantId, orderId),
    ])
    if (!order) throw new NotFoundError('Order')

    /*
     * The branch check, ported from the order detail page.
     *
     * Its comment there records a real cross-branch leak reachable through
     * exactly this id, and the query above enforces nothing but the tenant. The
     * message is the same as a genuine miss on purpose: a refusal and a
     * not-found must be indistinguishable, or the id becomes an oracle for
     * which orders exist at other branches.
     */
    if (!canAccessBranch(user, order.branchId)) throw new NotFoundError('Order')

    const view: OrderDetailView = {
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
        refunded: payment.refunds.reduce((sum, refund) => sum + refund.amount, 0),
      })),
    }

    return {
      order: view,
      currency: restaurant.currency,
      locale: restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale,
      restaurant: {
        name: restaurant.name,
        addressLine: [restaurant.addressLine, restaurant.city].filter(Boolean).join(', ') || null,
        phone: restaurant.phone,
        paper: readPaperWidths(restaurant.printerConfig),
      },
      canUpdate: false,
      canCancel: false,
      canRefund: false,
    }
  })
}
