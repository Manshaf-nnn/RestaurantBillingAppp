'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ListOrdered, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { OrderStatusBadge, PaymentStatusBadge } from '@/components/ui/status'
import { EVENTS, type OrderSummaryPayload } from '@/lib/realtime/events'
import { formatMoney } from '@/lib/money'
import { useSocketEvent } from '@/hooks/use-socket'

export interface OrderRow {
  id: string
  orderNumber: string
  status: 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED' | 'COMPLETED' | 'CANCELLED'
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | 'FAILED'
  type: string
  tableNumber: string | null
  customerName: string
  customerPhone: string
  itemCount: number
  grandTotal: number
  placedAt: string
}

const STATUS_OPTIONS = ['ALL', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED']
const PAYMENT_OPTIONS = ['ALL', 'UNPAID', 'PARTIAL', 'PAID', 'REFUNDED']
const TYPE_OPTIONS = ['ALL', 'DINE_IN', 'TAKEAWAY', 'DELIVERY']

export function OrdersTable({
  orders,
  total,
  page,
  pageCount,
  currency,
  locale,
  filters,
  branchIds,
}: {
  orders: OrderRow[]
  total: number
  page: number
  pageCount: number
  currency: string
  locale: string
  filters: { search: string; status: string; paymentStatus: string; type: string }
  /** Locations this list is showing. Null means all of them. */
  branchIds: string[] | null
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [search, setSearch] = React.useState(filters.search)
  const [live, setLive] = React.useState(orders)

  const isOurs = React.useCallback(
    (payload: { branchId?: string }) =>
      branchIds === null || !payload.branchId || branchIds.includes(payload.branchId),
    [branchIds],
  )

  React.useEffect(() => setLive(orders), [orders])

  // A brand-new order shows up at the top of page 1 without a refresh.
  useSocketEvent(EVENTS.ORDER_CREATED, (payload: OrderSummaryPayload) => {
    /*
     * The loader for this table is branch-scoped; this handler was not, so a
     * live row for another branch appeared at the top of a list that had
     * deliberately filtered it out, and stayed until the next refresh.
     */
    if (!isOurs(payload)) return
    if (page !== 1 || filters.status !== 'ALL') return
    setLive((current) =>
      current.some((order) => order.id === payload.id)
        ? current
        : [
            {
              id: payload.id,
              orderNumber: payload.orderNumber,
              status: payload.status,
              paymentStatus: 'UNPAID',
              type: payload.type,
              tableNumber: payload.tableNumber,
              customerName: payload.customerName,
              customerPhone: payload.customerPhone,
              itemCount: payload.itemCount,
              grandTotal: payload.grandTotal,
              placedAt: payload.placedAt,
            },
            ...current.slice(0, 24),
          ],
    )
  })

  /**
   * Change one query parameter and navigate.
   *
   * The `next.delete('page')` used to run unconditionally, on the line after
   * the `set` — so `setParam('page', '2')` set the page and then removed it,
   * and every Next/Previous click landed back on page 1. Only the newest 25
   * orders were ever reachable from this screen, which read exactly like a
   * system that had stopped saving records. Nothing was lost; the door was
   * jammed.
   *
   * Resetting to page 1 is still right for a FILTER — asking for cancelled
   * orders while sitting on page 7 of all orders should not leave you past the
   * end of a shorter list — so it now happens for every key except the page
   * itself.
   */
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString())
    if (value && value !== 'ALL') next.set(key, value)
    else next.delete(key)
    if (key !== 'page') next.delete('page')
    router.push(`/dashboard/orders?${next.toString()}`)
  }

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault()
    setParam('search', search.trim())
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={submitSearch} className="flex-1 sm:max-w-xs">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Order #, name, phone, takeaway keyword, or table…"
            startIcon={<Search />}
          />
        </form>
        <Select value={filters.status} onValueChange={(value) => setParam('status', value)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((status) => (
              <SelectItem key={status} value={status}>
                {status === 'ALL' ? 'All statuses' : status.charAt(0) + status.slice(1).toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.paymentStatus} onValueChange={(value) => setParam('paymentStatus', value)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_OPTIONS.map((status) => (
              <SelectItem key={status} value={status}>
                {status === 'ALL' ? 'All payments' : status.charAt(0) + status.slice(1).toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.type} onValueChange={(value) => setParam('type', value)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_OPTIONS.map((type) => (
              <SelectItem key={type} value={type}>
                {type === 'ALL' ? 'All types' : type.replace('_', ' ').toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {live.length === 0 ? (
        <EmptyState icon={<ListOrdered />} title="No orders found" description="Adjust your filters or wait for new orders." />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead className="hidden sm:table-cell">Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Payment</TableHead>
                <TableHead className="hidden lg:table-cell">Time</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {live.map((order) => (
                <TableRow
                  key={order.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/dashboard/orders/${order.id}`)}
                >
                  <TableCell>
                    <Link href={`/dashboard/orders/${order.id}`} className="font-semibold hover:underline">
                      #{order.orderNumber}
                    </Link>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {order.tableNumber ? (
                        <Badge variant="secondary" size="sm">
                          T{order.tableNumber}
                        </Badge>
                      ) : (
                        <Badge variant="outline" size="sm">
                          {order.type === 'TAKEAWAY' ? 'takeaway' : order.type.replace('_', ' ').toLowerCase()}
                        </Badge>
                      )}
                      {order.itemCount} items
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <p className="text-sm font-medium">{order.customerName}</p>
                    <p className="text-xs text-muted-foreground">{order.customerPhone}</p>
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={order.status} showIcon={false} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <PaymentStatusBadge status={order.paymentStatus} />
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                    {new Date(order.placedAt).toLocaleString(locale, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatMoney(order.grandTotal, currency, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {pageCount > 1 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {pageCount} · {total} orders
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setParam('page', String(page - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount}
              onClick={() => setParam('page', String(page + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
