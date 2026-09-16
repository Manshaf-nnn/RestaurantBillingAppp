'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { HandCoins, ListOrdered, Search } from 'lucide-react'

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
import { formatDateTime } from '@/lib/datetime'
import { useSocketEvent } from '@/hooks/use-socket'
import { channelLabel } from '../channels'
import { TakePaymentDialog, type PayableOrder } from '@/features/payments/components/take-payment-dialog'
import type { OrderListTotals } from '../queries'

export interface OrderRow {
  id: string
  orderNumber: string
  status: 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED' | 'COMPLETED' | 'CANCELLED'
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | 'FAILED'
  type: string
  /** Where it came from (abc.md §1): QR, STAFF, COUNTER, PHONE, ONLINE. */
  channel: string
  tableNumber: string | null
  customerName: string
  customerPhone: string
  itemCount: number
  grandTotal: number
  tipAmount: number
  paidTotal: number
  placedAt: string
}

/** What a row still owes: total + tip − collected, never negative. */
const owedOn = (order: Pick<OrderRow, 'grandTotal' | 'tipAmount' | 'paidTotal'>) =>
  Math.max(0, order.grandTotal + order.tipAmount - order.paidTotal)

const STATUS_OPTIONS = ['ALL', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED']
const PAYMENT_OPTIONS = ['ALL', 'UNPAID', 'PARTIAL', 'PAID', 'REFUNDED']
const TYPE_OPTIONS = ['ALL', 'DINE_IN', 'TAKEAWAY', 'DELIVERY']
const CHANNEL_OPTIONS = ['ALL', 'QR', 'ONLINE', 'STAFF', 'COUNTER', 'PHONE']
const PER_PAGE_OPTIONS = ['50', '100', 'ALL'] as const

export function OrdersTable({
  orders,
  total,
  page,
  pageCount,
  currency,
  locale,
  timeZone,
  filters,
  branchIds,
  perPage,
  totals,
  range,
  canCollect = false,
}: {
  orders: OrderRow[]
  total: number
  page: number
  pageCount: number
  currency: string
  locale: string
  /** The restaurant's own clock — see lib/datetime. */
  timeZone?: string | null
  filters: { search: string; status: string; paymentStatus: string; type: string; channel: string }
  /** Locations this list is showing. Null means all of them. */
  branchIds: string[] | null
  /** 50 / 100 / All (abc.md §1). */
  perPage: 50 | 100 | 'ALL'
  /** The whole filtered set's money, whichever page is showing. */
  totals: OrderListTotals
  /** The period the rows were read for, as instants, so a live row is judged by it too. */
  range: { from: string; to: string }
  /** Holds payment.collect: may take payment from a row. */
  canCollect?: boolean
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [search, setSearch] = React.useState(filters.search)
  const [live, setLive] = React.useState(orders)
  const [liveTotals, setLiveTotals] = React.useState(totals)
  const [paying, setPaying] = React.useState<PayableOrder | null>(null)
  React.useEffect(() => setLiveTotals(totals), [totals])

  /*
   * Whether a live row belongs on THIS list: the period and every active
   * filter, not only the branch. A "today, unpaid, QR" list must not grow a
   * row for last week's paid counter sale because a socket said so.
   */
  const matchesFilters = React.useCallback(
    (row: OrderRow) => {
      const at = Date.parse(row.placedAt)
      if (at < Date.parse(range.from) || at > Date.parse(range.to)) return false
      if (filters.status !== 'ALL' && row.status !== filters.status) return false
      if (filters.paymentStatus !== 'ALL' && row.paymentStatus !== filters.paymentStatus) return false
      if (filters.type !== 'ALL' && row.type !== filters.type) return false
      if (filters.channel !== 'ALL' && row.channel !== filters.channel) return false
      if (filters.search) {
        const q = filters.search.toLowerCase()
        const hit =
          row.orderNumber.toLowerCase().includes(q) ||
          row.customerName.toLowerCase().includes(q) ||
          row.customerPhone.includes(filters.search) ||
          (row.tableNumber ?? '').toLowerCase().includes(q)
        if (!hit) return false
      }
      return true
    },
    [range.from, range.to, filters],
  )

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
    if (page !== 1) return
    const row: OrderRow = {
      id: payload.id,
      orderNumber: payload.orderNumber,
      status: payload.status,
      paymentStatus: 'UNPAID',
      type: payload.type,
      channel: payload.channel,
      tableNumber: payload.tableNumber,
      customerName: payload.customerName,
      customerPhone: payload.customerPhone,
      itemCount: payload.itemCount,
      grandTotal: payload.grandTotal,
      tipAmount: 0,
      paidTotal: 0,
      placedAt: payload.placedAt,
    }
    if (!matchesFilters(row)) return
    const limit = perPage === 'ALL' ? Number.POSITIVE_INFINITY : perPage
    setLive((current) => {
      if (current.some((order) => order.id === payload.id)) return current
      // The footer is the set's figures; a new row in the set moves them too.
      setLiveTotals((t) => ({
        ...t,
        count: t.count + 1,
        grandTotal: t.grandTotal + row.grandTotal,
        outstanding: t.outstanding + row.grandTotal,
      }))
      return [row, ...current].slice(0, limit)
    })
  })

  // Money taken from a row: the row and the footer move without a refetch,
  // and the page re-reads so the server's figures win over the estimate.
  const onPaid = (orderId: string, amount: number, settled: boolean) => {
    setLive((current) =>
      current.map((order) =>
        order.id === orderId
          ? { ...order, paidTotal: order.paidTotal + amount, paymentStatus: settled ? 'PAID' : 'PARTIAL' }
          : order,
      ),
    )
    setLiveTotals((t) => ({ ...t, paidTotal: t.paidTotal + amount, outstanding: Math.max(0, t.outstanding - amount) }))
    router.refresh()
  }

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
        {/* abc.md §1: where the order came from. */}
        <Select value={filters.channel} onValueChange={(value) => setParam('channel', value)}>
          <SelectTrigger className="w-36" aria-label="Source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHANNEL_OPTIONS.map((channel) => (
              <SelectItem key={channel} value={channel}>
                {channel === 'ALL' ? 'All sources' : channelLabel(channel)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={perPage === 'ALL' ? 'ALL' : String(perPage)} onValueChange={(value) => setParam('perPage', value)}>
          <SelectTrigger className="w-32" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PER_PAGE_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option === 'ALL' ? 'All rows' : `${option} rows`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* abc.md §1: the whole filtered set's money, whichever page is showing. */}
      <dl
        data-testid="orders-totals"
        className="grid grid-cols-2 gap-2 rounded-xl border bg-card p-3 text-sm shadow-soft sm:grid-cols-4"
      >
        <div>
          <dt className="text-xs text-muted-foreground">Orders</dt>
          <dd className="font-semibold tabular-nums">{liveTotals.count}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Total</dt>
          <dd className="font-semibold tabular-nums">{formatMoney(liveTotals.grandTotal + liveTotals.tipAmount, currency, locale)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Collected</dt>
          <dd className="font-semibold tabular-nums text-success">{formatMoney(liveTotals.paidTotal, currency, locale)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Outstanding</dt>
          <dd className={liveTotals.outstanding > 0 ? 'font-semibold tabular-nums text-destructive' : 'font-semibold tabular-nums'}>
            {formatMoney(liveTotals.outstanding, currency, locale)}
          </dd>
        </div>
      </dl>

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
                {canCollect ? <TableHead className="w-0" /> : null}
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
                    {formatDateTime(order.placedAt, { locale, timeZone })}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatMoney(order.grandTotal, currency, locale)}
                    {owedOn(order) > 0 && owedOn(order) !== order.grandTotal ? (
                      <p className="text-xs font-normal text-muted-foreground">
                        {formatMoney(owedOn(order), currency, locale)} due
                      </p>
                    ) : null}
                  </TableCell>
                  {canCollect ? (
                    <TableCell className="text-right">
                      {/* abc.md §1: take payment from the row — unpaid or part-paid, not cancelled. */}
                      {order.status !== 'CANCELLED' && (order.paymentStatus === 'UNPAID' || order.paymentStatus === 'PARTIAL') && owedOn(order) > 0 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(event) => {
                            event.stopPropagation()
                            setPaying({ id: order.id, orderNumber: order.orderNumber, due: owedOn(order) })
                          }}
                        >
                          <HandCoins /> Take payment
                        </Button>
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <TakePaymentDialog
        open={paying !== null}
        onOpenChange={(open) => { if (!open) setPaying(null) }}
        order={paying}
        currency={currency}
        locale={locale}
        onPaid={onPaid}
      />

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
