'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, PackageCheck, Send, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney } from '@/lib/money'
import { receiveGoodsAction, setPurchaseStatusAction } from '../actions'
import type { PurchaseDetail } from '../queries'
import { callAction } from '@/lib/use-action'

const STATUS: Record<string, { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' }> = {
  DRAFT: { label: 'Draft', variant: 'secondary' },
  PENDING_APPROVAL: { label: 'Awaiting approval', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  ORDERED: { label: 'Ordered', variant: 'secondary' },
  PARTIALLY_RECEIVED: { label: 'Partly received', variant: 'warning' },
  RECEIVED: { label: 'Received', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
}

/**
 * Purchase order detail and receiving.
 *
 * The receiving form defaults each line to its outstanding quantity, because
 * the common case is that the delivery matches the order — the person at the
 * back door should only have to change the exceptions. Rejected quantity is
 * beside accepted rather than hidden behind a toggle, since spoiled goods are
 * noticed at exactly the moment the rest are being counted in.
 */
export function ReceivePanel({
  detail,
  canApprove,
  canReceive,
}: {
  detail: PurchaseDetail
  canApprove: boolean
  canReceive: boolean
}) {
  const router = useRouter()
  const money = (m: number) => formatMoney(m, detail.currency)
  const status = STATUS[detail.status] ?? STATUS.DRAFT

  const receivable = ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(detail.status)
  const outstanding = detail.lines.filter((l) => l.outstanding > 0)

  const [accepted, setAccepted] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(detail.lines.map((l) => [l.id, l.outstanding > 0 ? String(l.outstanding) : ''])),
  )
  const [rejected, setRejected] = React.useState<Record<string, string>>({})
  const [batchNo, setBatchNo] = React.useState<Record<string, string>>({})
  const [expiry, setExpiry] = React.useState<Record<string, string>>({})
  const [supplierRef, setSupplierRef] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const move = async (next: string, reason?: string) => {
    setBusy(true)
    const result = await callAction(() => setPurchaseStatusAction({ purchaseId: detail.id, status: next, reason }))
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success('Order updated')
    router.refresh()
  }

  const receive = async () => {
    const lines = detail.lines
      .map((l) => ({
        purchaseItemId: l.id,
        acceptedQty: Number(accepted[l.id] ?? 0) || 0,
        rejectedQty: Number(rejected[l.id] ?? 0) || 0,
        batchNo: batchNo[l.id] ?? '',
        expiryDate: expiry[l.id] ?? '',
      }))
      .filter((l) => l.acceptedQty > 0 || l.rejectedQty > 0)

    if (lines.length === 0) { toast.error('Enter what arrived'); return }

    // An expiry-tracked item received without a date can never appear on the
    // expiry board, which is the one place it would have been useful. Better to
    // stop here than to accept it and quietly lose the ability to track it.
    const missing = detail.lines.filter(
      (l) => l.trackExpiry && !expiry[l.id] && (Number(accepted[l.id] ?? 0) || 0) > 0,
    )
    if (missing.length > 0) {
      toast.error(`Enter an expiry date for ${missing.map((m) => m.name).join(', ')}`)
      return
    }

    setBusy(true)
    const result = await callAction(() => receiveGoodsAction({ purchaseId: detail.id, supplierRef, lines }))
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(`${result.data.number} received — stock updated`)
    setRejected({})
    setBatchNo({})
    setExpiry({})
    setSupplierRef('')
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
        <Badge variant={status.variant}>{status.label}</Badge>
        {detail.supplierName && <span className="font-medium">{detail.supplierName}</span>}
        {detail.approvedByName && (
          <span className="text-muted-foreground">Approved by {detail.approvedByName}</span>
        )}
        <span className="ml-auto font-semibold tabular-nums">{money(detail.total)}</span>
      </div>

      {canApprove && ['DRAFT', 'PENDING_APPROVAL'].includes(detail.status) && (
        <SectionCard
          title="Approve this order"
          description="Approving commits the restaurant's money. Nothing enters stock until the goods actually arrive."
        >
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => move('APPROVED')} disabled={busy}>
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Approve
            </Button>
            <Button variant="destructive" onClick={() => move('CANCELLED', 'Not needed')} disabled={busy}>
              <XCircle className="mr-2 h-4 w-4" />
              Cancel order
            </Button>
          </div>
        </SectionCard>
      )}

      {canApprove && detail.status === 'APPROVED' && (
        <SectionCard title="Send to supplier" description="Mark the order as placed.">
          <Button onClick={() => move('ORDERED')} disabled={busy}>
            <Send className="mr-2 h-4 w-4" />
            Mark as ordered
          </Button>
        </SectionCard>
      )}

      <SectionCard title="Items" description="Ordered, received and still outstanding.">
        <div className="-mx-2 overflow-x-auto px-2">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">Item</th>
                <th className="pb-2 pr-3 text-right font-medium">Ordered</th>
                <th className="pb-2 pr-3 text-right font-medium">Received</th>
                <th className="pb-2 pr-3 text-right font-medium">Rejected</th>
                <th className="pb-2 pr-3 text-right font-medium">Outstanding</th>
                <th className="pb-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {detail.lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-2.5 pr-3 font-medium">{l.name}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{l.quantity} {l.unit.toLowerCase()}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{l.receivedQty}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-amber-600 dark:text-amber-400">{l.rejectedQty || '—'}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{l.outstanding || '—'}</td>
                  <td className="py-2.5 text-right tabular-nums text-muted-foreground">{money(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/*
        Why the receive form is not here.
        
        The reported symptom was "a new item shows in Purchase Order but not in
        Purchase/GRN". There is no separate GRN item list to be broken —
        receiving reads the order's own lines. What actually happened is that a
        new order is created DRAFT, DRAFT cannot be received, and this whole
        card simply did not render. The order was right, the item was on it, and
        the screen said nothing at all.
      */}
      {canReceive && !receivable && outstanding.length > 0 && (
        <SectionCard title="Not ready to receive">
          <p className="text-sm text-muted-foreground">
            {detail.status === 'DRAFT' || detail.status === 'PENDING_APPROVAL' ? (
              <>
                This order is still a <strong>{status.label.toLowerCase()}</strong>. Nothing can be
                received against it until it is approved — approving is what commits the money, so
                it happens before the van arrives, not after.
                {canApprove ? ' Use Approve above.' : ' Ask someone who can approve orders.'}
              </>
            ) : detail.status === 'CANCELLED' ? (
              'This order was cancelled. Raise a new one if the goods are still coming.'
            ) : (
              'Everything on this order has already been received.'
            )}
          </p>
        </SectionCard>
      )}

      {canReceive && receivable && outstanding.length > 0 && (
        <SectionCard
          title="Receive delivery"
          description="Enter what actually arrived. Only the accepted quantity enters stock — rejected goods are recorded but never counted in."
        >
          <div className="mb-3 max-w-xs space-y-1">
            <Label htmlFor="ref" className="text-xs">Supplier delivery note (optional)</Label>
            <Input id="ref" placeholder="e.g. DN-4471" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} />
          </div>

          <ul className="space-y-3">
            {outstanding.map((l) => (
              <li key={l.id} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-12 sm:col-span-5">
                  <p className="font-medium">{l.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {l.outstanding} {l.unit.toLowerCase()} outstanding
                  </p>
                </div>
                <div className="col-span-6 space-y-1 sm:col-span-3">
                  <Label className="text-xs">Accepted</Label>
                  <Input
                    inputMode="decimal"
                    value={accepted[l.id] ?? ''}
                    onChange={(e) => setAccepted((c) => ({ ...c, [l.id]: e.target.value }))}
                  />
                </div>
                <div className="col-span-6 space-y-1 sm:col-span-3">
                  <Label className="text-xs">Rejected</Label>
                  <Input
                    inputMode="decimal"
                    placeholder="0"
                    value={rejected[l.id] ?? ''}
                    onChange={(e) => setRejected((c) => ({ ...c, [l.id]: e.target.value }))}
                  />
                </div>

                {(l.trackBatches || l.trackExpiry) && (
                  <>
                    {l.trackBatches && (
                      <div className="col-span-6 space-y-1 sm:col-span-3 sm:col-start-6">
                        <Label className="text-xs">Batch / lot number</Label>
                        <Input
                          placeholder="e.g. CHK-2026-0819"
                          value={batchNo[l.id] ?? ''}
                          onChange={(e) => setBatchNo((c) => ({ ...c, [l.id]: e.target.value }))}
                        />
                      </div>
                    )}
                    {l.trackExpiry && (
                      <div className="col-span-6 space-y-1 sm:col-span-3">
                        <Label className="text-xs">Expiry date</Label>
                        <Input
                          type="date"
                          value={expiry[l.id] ?? ''}
                          onChange={(e) => setExpiry((c) => ({ ...c, [l.id]: e.target.value }))}
                        />
                      </div>
                    )}
                    <p className="col-span-12 -mt-1 text-xs text-muted-foreground">
                      {l.trackBatches && !batchNo[l.id]
                        ? 'Leave the batch blank and it will be numbered after this delivery note.'
                        : 'Tracked stock — this appears on the expiry board.'}
                    </p>
                  </>
                )}
              </li>
            ))}
          </ul>

          <Button className="mt-4" onClick={receive} disabled={busy}>
            <PackageCheck className="mr-2 h-4 w-4" />
            {busy ? 'Receiving…' : 'Receive into stock'}
          </Button>
        </SectionCard>
      )}

      {detail.receipts.length > 0 && (
        <SectionCard title="Deliveries" description="Every arrival against this order.">
          <ul className="divide-y divide-border">
            {detail.receipts.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{r.number}</span>
                  {r.supplierRef && <span className="text-muted-foreground">· {r.supplierRef}</span>}
                  <span className="ml-auto text-muted-foreground">
                    <LocalDateTime value={r.receivedAt} />
                    {r.receivedByName ? ` · ${r.receivedByName}` : ''}
                  </span>
                </div>
                <ul className="mt-1 text-xs text-muted-foreground">
                  {r.lines.map((line, i) => (
                    <li key={i}>
                      {line.name}: {line.acceptedQty} accepted
                      {line.rejectedQty > 0 ? `, ${line.rejectedQty} rejected` : ''}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  )
}
