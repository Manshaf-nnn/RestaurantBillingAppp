'use client'

import * as React from 'react'
import Link from 'next/link'
import { AnimatePresence, motion } from 'framer-motion'
import type { OrderStatus, PaymentStatus } from '@prisma/client'

import { Badge } from '@/components/ui/badge'
import { OrderStatusBadge, PaymentStatusBadge } from '@/components/ui/status'
import { EVENTS, type OrderStatusPayload, type OrderSummaryPayload } from '@/lib/realtime/events'
import { formatMoney } from '@/lib/money'
import { useSocketEvent } from '@/hooks/use-socket'

export interface FeedOrder {
  id: string
  orderNumber: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  tableNumber: string | null
  customerName: string
  itemCount: number
  grandTotal: number
  placedAt: string
}

/** The dashboard's live order strip — new tickets slide in without a refresh. */
export function LiveOrderFeed({
  initialOrders,
  currency,
  locale,
}: {
  initialOrders: FeedOrder[]
  currency: string
  locale: string
}) {
  const [orders, setOrders] = React.useState(initialOrders)

  useSocketEvent(EVENTS.ORDER_CREATED, (payload: OrderSummaryPayload) => {
    setOrders((current) => [
      {
        id: payload.id,
        orderNumber: payload.orderNumber,
        status: payload.status,
        paymentStatus: 'UNPAID',
        tableNumber: payload.tableNumber,
        customerName: payload.customerName,
        itemCount: payload.itemCount,
        grandTotal: payload.grandTotal,
        placedAt: payload.placedAt,
      },
      ...current.filter((order) => order.id !== payload.id).slice(0, 7),
    ])
  })

  useSocketEvent(EVENTS.ORDER_STATUS, (payload: OrderStatusPayload) => {
    setOrders((current) =>
      current.map((order) =>
        order.id === payload.orderId ? { ...order, status: payload.status } : order,
      ),
    )
  })

  useSocketEvent(EVENTS.PAYMENT_RECEIVED, (payload: { orderId: string }) => {
    setOrders((current) =>
      current.map((order) =>
        order.id === payload.orderId ? { ...order, paymentStatus: 'PAID' } : order,
      ),
    )
  })

  return (
    <ul className="divide-y">
      <AnimatePresence initial={false}>
        {orders.map((order) => (
          <motion.li
            key={order.id}
            layout
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <Link
              href={`/dashboard/orders/${order.id}`}
              className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  #{order.orderNumber}
                  {order.tableNumber ? (
                    <Badge variant="secondary" size="sm">
                      T{order.tableNumber}
                    </Badge>
                  ) : null}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {order.customerName} · {order.itemCount} item
                  {order.itemCount === 1 ? '' : 's'} ·{' '}
                  {new Date(order.placedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>

              <div className="hidden items-center gap-1.5 sm:flex">
                <OrderStatusBadge status={order.status} showIcon={false} />
                <PaymentStatusBadge status={order.paymentStatus} />
              </div>

              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {formatMoney(order.grandTotal, currency, locale)}
              </span>
            </Link>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}
