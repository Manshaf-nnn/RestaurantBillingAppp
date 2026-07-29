import type { PaymentMethod, PaymentStatus } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

export interface OnlinePaymentRow {
  id: string
  status: PaymentStatus
  method: PaymentMethod
  amount: number
  reference: string | null
  createdAt: string
  orderId: string
  orderNumber: string
  tableNumber: string | null
  customerName: string
  grandTotal: number
  paidTotal: number
  orderPaymentStatus: PaymentStatus
}

/**
 * Every payment a guest settled (or declared) online — bank transfer or gateway
 * — so the owner can cross-check them against the bank and confirm receipts.
 */
export async function getOnlinePayments(restaurantId: string): Promise<OnlinePaymentRow[]> {
  const rows = await prisma.payment.findMany({
    where: {
      restaurantId,
      OR: [{ method: 'ONLINE' }, { reference: { contains: 'transfer', mode: 'insensitive' } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 80,
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          grandTotal: true,
          paidTotal: true,
          paymentStatus: true,
          customerName: true,
          table: { select: { number: true } },
        },
      },
    },
  })

  return rows.map((p) => ({
    id: p.id,
    status: p.status,
    method: p.method,
    amount: p.amount,
    reference: p.reference,
    createdAt: p.createdAt.toISOString(),
    orderId: p.order.id,
    orderNumber: p.order.orderNumber,
    tableNumber: p.order.table?.number ?? null,
    customerName: p.order.customerName,
    grandTotal: p.order.grandTotal,
    paidTotal: p.order.paidTotal,
    orderPaymentStatus: p.order.paymentStatus,
  }))
}
