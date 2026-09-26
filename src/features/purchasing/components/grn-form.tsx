'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  FileText,
  PackageCheck,
  Truck,
  UserRound,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { newRequestKey } from '@/lib/request-key'
import { formatMoney, minorUnitFactor, toMajor, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { receiveGoodsAction } from '../actions'
import type { AwaitingDelivery, PurchaseDetail } from '../queries'
import { PO_STATUS, formatPercent, priceChange } from '../status'
import { ItemAvatar } from './item-price-panel'

/**
 * Purchase receiving — the goods received note.
 *
 * Select PO → its details → the receiving table → variance → confirm. The
 * table defaults every line to what is still outstanding at the price the
 * order agreed, because the common delivery matches the order and the person
 * at the back door should only have to change the exceptions: fewer boxes,
 * a different price on the invoice, a spoiled crate.
 *
 * ── What confirming does, and does not do ───────────────────────────────────
 *
 * Confirming posts one FIFO layer per accepted line at the price actually
 * charged (`receiveGoods`), and derives the order's status from its lines.
 * It cannot receive more than was ordered — the server refuses that under a
 * lock — and it does not rewrite the order: a price that differs is recorded
 * as a variance on the receipt line and shown here as one, not written back
 * onto the approved PO.
 */
export function GrnForm({
  awaiting,
  detail,
  receiverName,
  locations,
}: {
  awaiting: AwaitingDelivery[]
  /** The order chosen in the select, loaded by the page. Null until one is. */
  detail: PurchaseDetail | null
  receiverName: string
  /** Where a delivery may be diverted to, when it did not go where planned. */
  locations: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const currency = (detail?.currency ?? 'INR') as CurrencyCode
  const factor = minorUnitFactor(currency)
  const money = (m: number) => formatMoney(m, currency)

  const outstanding = React.useMemo(() => detail?.lines.filter((l) => l.outstanding > 0) ?? [], [detail])

  const [receive, setReceive] = React.useState<Record<string, string>>({})
  const [rejected, setRejected] = React.useState<Record<string, string>>({})
  const [actual, setActual] = React.useState<Record<string, string>>({})
  const [batchNo, setBatchNo] = React.useState<Record<string, string>>({})
  const [expiry, setExpiry] = React.useState<Record<string, string>>({})
  const [supplierRef, setSupplierRef] = React.useState('')
  const [invoiceDate, setInvoiceDate] = React.useState('')
  const [destination, setDestination] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const requestKey = React.useRef(newRequestKey('receive'))

  // A fresh order in the select starts a fresh form.
  React.useEffect(() => {
    setReceive(Object.fromEntries(outstanding.map((l) => [l.id, String(l.outstanding)])))
    setRejected({})
    setActual(Object.fromEntries(outstanding.map((l) => [l.id, String(toMajor(l.unitCost, currency))])))
    setBatchNo({})
    setExpiry({})
    setSupplierRef('')
    setInvoiceDate('')
    setDestination('')
    setNotes('')
    requestKey.current = newRequestKey('receive')
  }, [detail?.id, outstanding, currency])

  const qty = (id: string) => Number(receive[id] ?? 0) || 0
  const rej = (id: string) => Number(rejected[id] ?? 0) || 0
  const actualMinor = (line: PurchaseDetail['lines'][number]) => {
    const typed = actual[line.id]
    return typed === undefined || typed === '' ? line.unitCost : Math.round((Number(typed) || 0) * factor)
  }

  const partial = outstanding.filter((l) => qty(l.id) + rej(l.id) < l.outstanding - 1e-6)
  const over = outstanding.filter((l) => qty(l.id) + rej(l.id) > l.outstanding + 1e-6)
  const receivedQty = outstanding.reduce((sum, l) => sum + qty(l.id), 0)
  const receivedValue = outstanding.reduce((sum, l) => sum + Math.round(qty(l.id) * actualMinor(l)), 0)
  const variances = outstanding.filter((l) => qty(l.id) > 0 && actualMinor(l) !== l.unitCost)

  const confirm = async () => {
    if (!detail) return
    const lines = outstanding
      .map((l) => ({
        purchaseItemId: l.id,
        acceptedQty: qty(l.id),
        rejectedQty: rej(l.id),
        unitCost: actual[l.id] !== undefined && actual[l.id] !== '' ? Number(actual[l.id]) : undefined,
        batchNo: batchNo[l.id] ?? '',
        expiryDate: expiry[l.id] ?? '',
      }))
      .filter((l) => l.acceptedQty > 0 || l.rejectedQty > 0)

    if (lines.length === 0) {
      toast.error('Enter what arrived')
      return
    }
    if (over.length > 0) {
      toast.error(`${over[0].name}: more than the ${over[0].outstanding} still outstanding`)
      return
    }
    const missingExpiry = outstanding.filter((l) => l.trackExpiry && qty(l.id) > 0 && !expiry[l.id])
    if (missingExpiry.length > 0) {
      toast.error(`Enter an expiry date for ${missingExpiry.map((m) => m.name).join(', ')}`)
      return
    }

    setBusy(true)
    const result = await callAction(() =>
      receiveGoodsAction({
        purchaseId: detail.id,
        supplierRef,
        invoiceDate,
        notes,
        branchId: destination,
        lines,
        clientRequestId: requestKey.current,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    requestKey.current = newRequestKey('receive')
    toast.success(`${result.data.number} received — stock updated`)
    router.push(`/dashboard/purchases/${detail.id}`)
  }

  return (
    <div className="space-y-4">
      {/* ── select PO ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card px-5 py-4 shadow-soft">
        <label htmlFor="grn-po" className="text-sm font-semibold">
          Select approved PO
        </label>
        <select
          id="grn-po"
          value={detail?.id ?? ''}
          onChange={(e) =>
            router.push(e.target.value ? `/dashboard/purchases/receive?po=${e.target.value}` : '/dashboard/purchases/receive')
          }
          className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
        >
          <option value="">Choose an order awaiting delivery…</option>
          {awaiting.map((po) => (
            <option key={po.id} value={po.id}>
              {po.number} · {po.supplierName ?? 'No supplier'} · {formatMoney(po.total, currency)} ·{' '}
              {po.outstandingQty} still to come
            </option>
          ))}
          {detail && !awaiting.some((po) => po.id === detail.id) ? (
            <option value={detail.id}>{detail.number}</option>
          ) : null}
        </select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Only approved orders with something still outstanding are listed. A draft or a pending request
          cannot be received against.
        </p>
      </section>

      {detail ? (
        <>
          {/* ── the order, the invoice, the receiver ─────────────────────── */}
          <section className="grid gap-3 rounded-xl border bg-card px-5 py-4 shadow-soft sm:grid-cols-2 lg:grid-cols-5">
            <Fact icon={<Truck />} label="Supplier" value={detail.supplierName ?? 'Not chosen'} />
            <div className="flex items-start gap-2.5">
              <FactIcon icon={<Building2 />} />
              <div className="min-w-0 flex-1">
                <label htmlFor="grn-dest" className="text-[11px] text-muted-foreground">
                  Location
                </label>
                {locations.length > 1 ? (
                  <select
                    id="grn-dest"
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    className="mt-0.5 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value="">{detail.branchName ?? 'As ordered'}</option>
                    {locations
                      .filter((l) => l.id !== detail.branchId)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name} (diverted)
                        </option>
                      ))}
                  </select>
                ) : (
                  <p className="text-sm font-medium">{detail.branchName ?? '—'}</p>
                )}
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <FactIcon icon={<FileText />} />
              <div className="min-w-0 flex-1">
                <label htmlFor="grn-inv" className="text-[11px] text-muted-foreground">
                  Invoice no.
                </label>
                <Input
                  id="grn-inv"
                  value={supplierRef}
                  onChange={(e) => setSupplierRef(e.target.value)}
                  placeholder="e.g. INV-45821"
                  className="mt-0.5 h-8"
                />
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <FactIcon icon={<CalendarDays />} />
              <div className="min-w-0 flex-1">
                <label htmlFor="grn-date" className="text-[11px] text-muted-foreground">
                  Invoice date
                </label>
                <Input
                  id="grn-date"
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className="mt-0.5 h-8"
                />
              </div>
            </div>
            <Fact icon={<UserRound />} label="Received by" value={receiverName} />
          </section>

          {/* ── receiving items ──────────────────────────────────────────── */}
          <section className="rounded-xl border bg-card shadow-soft">
            <header className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
              <h3 className="text-sm font-semibold">Receiving items</h3>
              <Badge variant={PO_STATUS[detail.status].variant}>{PO_STATUS[detail.status].label}</Badge>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[60rem] text-sm">
                <thead>
                  <tr className="border-y bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2.5 font-medium">Item</th>
                    <th className="px-3 py-2.5 text-right font-medium">Ordered</th>
                    <th className="px-3 py-2.5 text-right font-medium">Previously rec.</th>
                    <th className="px-3 py-2.5 font-medium">Receive now</th>
                    <th className="px-3 py-2.5 font-medium">Rejected</th>
                    <th className="px-3 py-2.5 font-medium">Unit</th>
                    <th className="px-3 py-2.5 text-right font-medium">PO price</th>
                    <th className="px-3 py-2.5 text-right font-medium">Last price</th>
                    <th className="px-3 py-2.5 font-medium">Actual price</th>
                    <th className="px-5 py-2.5 text-right font-medium">Variance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {outstanding.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-5 py-8 text-center text-sm text-muted-foreground">
                        Everything on this order has already been received.
                      </td>
                    </tr>
                  ) : (
                    outstanding.map((line) => {
                      const last = detail.lastPurchaseByItem[line.itemId]
                      const paid = actualMinor(line)
                      const change = priceChange(line.unitCost, paid)
                      const tooMany = qty(line.id) + rej(line.id) > line.outstanding + 1e-6
                      const tracked = line.trackBatches || line.trackExpiry
                      return (
                        <React.Fragment key={line.id}>
                          <tr className={cn(tracked && 'border-b-0')}>
                            <td className="px-5 py-3">
                              <div className="flex items-center gap-3">
                                <ItemAvatar name={line.name} />
                                <p className="font-medium">{line.name}</p>
                              </div>
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums">
                              {line.quantity} {line.unit.toLowerCase()}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                              {line.receivedQty} {line.unit.toLowerCase()}
                            </td>
                            <td className="px-3 py-3">
                              <Input
                                inputMode="decimal"
                                value={receive[line.id] ?? ''}
                                onChange={(e) => setReceive((c) => ({ ...c, [line.id]: e.target.value }))}
                                className={cn('h-9 w-20 text-right tabular-nums', tooMany && 'border-destructive')}
                                aria-label={`Receive now: ${line.name}`}
                              />
                            </td>
                            <td className="px-3 py-3">
                              <Input
                                inputMode="decimal"
                                placeholder="0"
                                value={rejected[line.id] ?? ''}
                                onChange={(e) => setRejected((c) => ({ ...c, [line.id]: e.target.value }))}
                                className="h-9 w-16 text-right tabular-nums"
                                aria-label={`Rejected: ${line.name}`}
                              />
                            </td>
                            <td className="px-3 py-3 text-muted-foreground">{line.unit.toLowerCase()}</td>
                            <td className="px-3 py-3 text-right tabular-nums">{money(line.unitCost)}</td>
                            <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                              {last ? money(last.unitCost) : '—'}
                            </td>
                            <td className="px-3 py-3">
                              <Input
                                inputMode="decimal"
                                value={actual[line.id] ?? ''}
                                onChange={(e) => setActual((c) => ({ ...c, [line.id]: e.target.value }))}
                                className="h-9 w-24 text-right tabular-nums"
                                aria-label={`Actual price: ${line.name}`}
                              />
                            </td>
                            <td className="px-5 py-3 text-right">
                              <Variance change={change} />
                            </td>
                          </tr>
                          {tracked ? (
                            <tr>
                              <td colSpan={10} className="px-5 pb-3 pt-0">
                                <div className="flex flex-wrap items-center gap-2 pl-12 text-xs">
                                  {line.trackBatches ? (
                                    <Input
                                      placeholder="Batch / lot number (blank = numbered after this GRN)"
                                      value={batchNo[line.id] ?? ''}
                                      onChange={(e) => setBatchNo((c) => ({ ...c, [line.id]: e.target.value }))}
                                      className="h-8 max-w-xs"
                                      aria-label={`Batch number: ${line.name}`}
                                    />
                                  ) : null}
                                  {line.trackExpiry ? (
                                    <Input
                                      type="date"
                                      value={expiry[line.id] ?? ''}
                                      onChange={(e) => setExpiry((c) => ({ ...c, [line.id]: e.target.value }))}
                                      className="h-8 max-w-[11rem]"
                                      aria-label={`Expiry date: ${line.name}`}
                                    />
                                  ) : null}
                                  <span className="text-muted-foreground">Tracked stock — appears on the expiry board.</span>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {over.length > 0 ? (
              <p className="mx-5 mb-3 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertTriangle className="size-4 shrink-0" />
                {over.map((l) => `${l.name}: ${qty(l.id) + rej(l.id)} entered, ${l.outstanding} outstanding`).join(' · ')}.
                A delivery cannot exceed the approved order.
              </p>
            ) : partial.length > 0 ? (
              <p className="mx-5 mb-3 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                <AlertTriangle className="size-4 shrink-0 text-warning" />
                <span>
                  <strong>Partial receiving:</strong>{' '}
                  {partial
                    .map((l) => `${l.name} – ${Math.round((l.outstanding - qty(l.id) - rej(l.id)) * 1e6) / 1e6} ${l.unit.toLowerCase()} remaining on this PO`)
                    .join(' · ')}
                  .
                </span>
              </p>
            ) : null}
          </section>

          {/* ── summary, notes, confirm ──────────────────────────────────── */}
          <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
            <section className="rounded-xl border bg-card px-5 py-4 shadow-soft">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <ClipboardList className="size-4 text-primary" /> Purchase summary
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-[11px] text-muted-foreground">Total items</dt>
                  <dd className="font-semibold tabular-nums">{outstanding.length}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">Received qty</dt>
                  <dd className="font-semibold tabular-nums">
                    {Math.round(receivedQty * 1e6) / 1e6}
                    {partial.length > 0 ? <span className="ml-1 text-xs font-normal text-warning">(partial)</span> : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">Received value</dt>
                  <dd className="font-semibold tabular-nums">{money(receivedValue)}</dd>
                </div>
              </dl>
              {variances.length > 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {variances.length} {variances.length === 1 ? 'line is' : 'lines are'} priced differently from the
                  order. The delivered price is what stock is valued at; the order is not changed.
                </p>
              ) : null}
            </section>
            <section className="flex flex-col rounded-xl border bg-card px-5 py-4 shadow-soft">
              <label htmlFor="grn-notes" className="text-sm font-semibold">
                Notes <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                id="grn-notes"
                rows={2}
                placeholder="e.g. Good condition, no damage…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="mt-2"
              />
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button variant="outline" asChild disabled={busy}>
                  <Link href={`/dashboard/purchases/${detail.id}`}>Cancel</Link>
                </Button>
                <Button onClick={confirm} disabled={busy || outstanding.length === 0 || over.length > 0}>
                  <PackageCheck /> {busy ? 'Receiving…' : 'Confirm receiving'}
                </Button>
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  )
}

function Variance({ change }: { change: number }) {
  if (Math.abs(change) < 0.0005) {
    return (
      <span className="inline-flex items-center gap-1 text-success">
        0% <CheckCircle2 className="size-3.5" />
      </span>
    )
  }
  const dearer = change > 0
  return (
    <span className={cn('inline-flex items-center gap-1 font-medium tabular-nums', dearer ? 'text-warning' : 'text-success')}>
      {formatPercent(change)}
      {dearer ? <AlertTriangle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
    </span>
  )
}

function FactIcon({ icon }: { icon: React.ReactNode }) {
  return (
    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:size-3.5">
      {icon}
    </span>
  )
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <FactIcon icon={icon} />
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <div className="truncate text-sm font-medium">{value}</div>
      </div>
    </div>
  )
}
