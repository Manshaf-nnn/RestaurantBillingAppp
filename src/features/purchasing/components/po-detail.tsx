'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Building2,
  CalendarDays,
  CheckCircle2,
  MessageSquareText,
  PackageCheck,
  Pencil,
  Send,
  ShieldAlert,
  Truck,
  Undo2,
  UserRound,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { decidePurchaseAction, setPurchaseStatusAction, submitPurchaseAction } from '../actions'
import type { PurchaseDetail } from '../queries'
import { PO_PRIORITY, PO_STATUS, formatPercent, priceChange } from '../status'
import { ItemAvatar } from './item-price-panel'

type Decision = 'APPROVE' | 'REJECT' | 'RETURN'

/**
 * One purchase request, from raised to closed.
 *
 * Header strip → items → reason → what to do next. The buttons at the foot
 * are the whole workflow: a requester saves and submits, an approver
 * approves, returns or rejects (the last two with a reason, always), a buyer
 * marks it ordered, a storekeeper goes to receive it, and somebody closes it.
 * Receiving itself lives on the GRN screen — this page only ever points there.
 */
export function PoDetail({
  detail,
  canApprove,
  canCreate,
  canReceive,
  approval,
}: {
  detail: PurchaseDetail
  canApprove: boolean
  canCreate: boolean
  canReceive: boolean
  /**
   * The desk request still open for this order, and whether this viewer may
   * decide it normally. Null blockedReason means they may; a reason with
   * `mayForce` means they may override, on the record.
   */
  approval: { pendingId: string | null; blockedReason: string | null; mayForce: boolean }
}) {
  const router = useRouter()
  const currency = detail.currency as CurrencyCode
  const money = (m: number) => formatMoney(m, currency)
  const status = PO_STATUS[detail.status]
  const priority = PO_PRIORITY[detail.priority]

  const [asking, setAsking] = React.useState<Exclude<Decision, 'APPROVE'> | null>(null)
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const pending = detail.status === 'PENDING_APPROVAL'
  const receivable = ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(detail.status)
  const anyReceived = detail.lines.some((l) => l.receivedQty > 0 || l.rejectedQty > 0)
  const blocked = approval.blockedReason !== null

  const decide = async (decision: Decision, force = false) => {
    if (decision !== 'APPROVE' && !reason.trim()) {
      toast.error(decision === 'REJECT' ? 'Give a reason for rejecting this request' : 'Say what needs changing')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      decidePurchaseAction({ purchaseId: detail.id, decision, reason: reason.trim(), force }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      decision === 'APPROVE'
        ? result.data.forced
          ? 'Approved — recorded as an override'
          : 'Approved'
        : decision === 'REJECT'
          ? 'Rejected'
          : 'Sent back for edit',
    )
    setAsking(null)
    setReason('')
    router.refresh()
  }

  const move = async (next: 'ORDERED' | 'CLOSED' | 'CANCELLED' | 'DRAFT', note?: string) => {
    if (next === 'CANCELLED' && !window.confirm(`Cancel ${detail.number}? This cannot be undone.`)) return
    setBusy(true)
    const result = await callAction(() =>
      setPurchaseStatusAction({ purchaseId: detail.id, status: next, reason: note }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Order updated')
    router.refresh()
  }

  const submit = async () => {
    setBusy(true)
    const result = await callAction(() => submitPurchaseAction({ purchaseId: detail.id }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Sent for approval')
    router.refresh()
  }

  return (
    <div className="space-y-4">
      {/* ── who, where, when ───────────────────────────────────────────── */}
      <section className="grid gap-3 rounded-xl border bg-card px-5 py-4 shadow-soft sm:grid-cols-2 lg:grid-cols-5">
        <Fact icon={<UserRound />} label="Requested by" value={detail.createdByName ?? '—'} />
        <Fact icon={<Building2 />} label="Location" value={detail.branchName ?? '—'} />
        <Fact icon={<Truck />} label="Supplier" value={detail.supplierName ?? 'Not chosen'} />
        <Fact
          icon={<CalendarDays />}
          label="Required date"
          value={detail.expectedAt ? <LocalDateTime value={detail.expectedAt} /> : '—'}
        />
        <Fact
          icon={<ShieldAlert />}
          label="Priority"
          value={<Badge variant={priority.variant}>{priority.label}</Badge>}
        />
      </section>

      {detail.decisionNote && (detail.status === 'REJECTED' || detail.status === 'RETURNED') ? (
        <Alert variant={detail.status === 'REJECTED' ? 'destructive' : 'warning'}>
          <strong>{detail.status === 'REJECTED' ? 'Rejected: ' : 'Returned for edit: '}</strong>
          {detail.decisionNote}
        </Alert>
      ) : null}
      {detail.status === 'CANCELLED' && detail.cancelReason ? (
        <Alert variant="destructive">
          <strong>Cancelled: </strong>
          {detail.cancelReason}
        </Alert>
      ) : null}

      {/* ── items ──────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card shadow-soft">
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="flex items-center gap-2 font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <PackageCheck className="size-4" />
            </span>
            {detail.lines.length} {detail.lines.length === 1 ? 'item' : 'items'}
          </p>
          <div className="text-right">
            <p className="text-lg font-bold tabular-nums">{money(detail.total)}</p>
            <p className="text-xs text-muted-foreground">
              {detail.status === 'APPROVED' || receivable || anyReceived ? 'Approved total' : 'Estimated total'}
            </p>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-y bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Item</th>
                <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                <th className="px-3 py-2.5 font-medium">Unit</th>
                {anyReceived ? (
                  <>
                    <th className="px-3 py-2.5 text-right font-medium">Received</th>
                    <th className="px-3 py-2.5 text-right font-medium">Outstanding</th>
                  </>
                ) : null}
                <th className="px-3 py-2.5 text-right font-medium">Price</th>
                <th className="px-5 py-2.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {detail.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <ItemAvatar name={line.name} />
                      <Link href={`/dashboard/inventory/${line.itemId}`} className="font-medium hover:underline">
                        {line.name}
                      </Link>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{line.quantity}</td>
                  <td className="px-3 py-3 text-muted-foreground">{line.unit.toLowerCase()}</td>
                  {anyReceived ? (
                    <>
                      <td className="px-3 py-3 text-right tabular-nums text-success">
                        {line.receivedQty}
                        {line.rejectedQty > 0 ? (
                          <span className="block text-xs text-warning">{line.rejectedQty} rejected</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{line.outstanding || '—'}</td>
                    </>
                  ) : null}
                  <td className="px-3 py-3 text-right tabular-nums">{money(line.unitCost)}</td>
                  <td className="px-5 py-3 text-right font-medium tabular-nums">{money(line.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── reason ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card px-5 py-4 shadow-soft">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessageSquareText className="size-3.5" /> Request reason
        </p>
        <p className="mt-1 text-sm">{detail.notes?.trim() || <span className="text-muted-foreground">None given.</span>}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Raised <LocalDateTime value={detail.createdAt} />
          {detail.submittedAt ? (
            <>
              {' · submitted '}
              <LocalDateTime value={detail.submittedAt} />
            </>
          ) : null}
          {detail.approvedByName && detail.approvedAt ? (
            <>
              {' · approved by '}
              {detail.approvedByName} <LocalDateTime value={detail.approvedAt} />
            </>
          ) : null}
        </p>
      </section>

      {/* ── deliveries ─────────────────────────────────────────────────── */}
      {detail.receipts.length > 0 ? (
        <section className="rounded-xl border bg-card shadow-soft">
          <header className="border-b px-5 py-4">
            <h3 className="text-sm font-semibold">Deliveries</h3>
            <p className="text-xs text-muted-foreground">Every arrival against this order, at what it actually cost.</p>
          </header>
          <ul className="divide-y">
            {detail.receipts.map((r) => {
              const repriced = r.lines.filter((l) => l.unitCost !== l.orderedUnitCost)
              return (
                <li key={r.id} className="px-5 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/dashboard/purchases/${detail.id}/receipts/${r.id}`}
                      className="font-medium tabular-nums hover:underline"
                    >
                      {r.number}
                    </Link>
                    {r.supplierRef ? <span className="text-muted-foreground">· Inv {r.supplierRef}</span> : null}
                    {r.branchName ? <Badge variant="secondary">{r.branchName}</Badge> : null}
                    {repriced.length > 0 ? (
                      <Badge variant="warning">{repriced.length} price {repriced.length === 1 ? 'variance' : 'variances'}</Badge>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      <LocalDateTime value={r.receivedAt} />
                      {r.receivedByName ? ` · ${r.receivedByName}` : ''}
                    </span>
                    <span className="font-medium tabular-nums">{money(r.value)}</span>
                  </div>
                  <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                    {r.lines.map((line, i) => (
                      <li key={i}>
                        {line.name}: {line.acceptedQty} {line.unit?.toLowerCase() ?? ''}
                        {line.rejectedQty > 0 ? `, ${line.rejectedQty} rejected` : ''}
                        {line.unitCost !== line.orderedUnitCost ? (
                          <span className={cn('ml-1', line.unitCost > line.orderedUnitCost ? 'text-warning' : 'text-success')}>
                            ({formatPercent(priceChange(line.orderedUnitCost, line.unitCost))})
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {/* ── what happens next ──────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card px-5 py-4 shadow-soft">
        {pending && canApprove ? (
          <div className="space-y-3">
            {blocked ? (
              <Alert variant="warning">
                {approval.blockedReason}.
                {approval.mayForce
                  ? ' You can override this; the override is recorded against the request permanently.'
                  : ''}
              </Alert>
            ) : null}
            {asking ? (
              <div className="space-y-2">
                <Input
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value.slice(0, 300))}
                  placeholder={asking === 'REJECT' ? 'Why is this rejected?' : 'What needs changing?'}
                  aria-label="Reason"
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" onClick={() => setAsking(null)} disabled={busy}>
                    Back
                  </Button>
                  <Button
                    variant={asking === 'REJECT' ? 'destructive' : 'default'}
                    onClick={() => decide(asking, blocked && approval.mayForce)}
                    disabled={busy || !reason.trim()}
                  >
                    {asking === 'REJECT' ? 'Confirm reject' : 'Send back for edit'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                  onClick={() => setAsking('REJECT')}
                  disabled={busy || (blocked && !approval.mayForce)}
                >
                  <XCircle /> Reject
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setAsking('RETURN')}
                  disabled={busy || (blocked && !approval.mayForce)}
                >
                  <Pencil /> Return for edit
                </Button>
                <Button
                  variant={blocked ? 'destructive' : 'default'}
                  className={cn(!blocked && 'bg-success text-success-foreground hover:bg-success/90')}
                  onClick={() => decide('APPROVE', blocked && approval.mayForce)}
                  disabled={busy || (blocked && !approval.mayForce)}
                >
                  {blocked ? <ShieldAlert /> : <CheckCircle2 />}
                  {blocked ? 'Override and approve' : 'Approve PO'}
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {(detail.status === 'DRAFT' || detail.status === 'RETURNED') && (canCreate || canApprove) ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canCreate ? (
              <>
                <Button variant="outline" asChild>
                  <Link href={`/dashboard/purchases/${detail.id}/edit`}>
                    <Pencil /> Edit
                  </Link>
                </Button>
                <Button variant="ghost" onClick={() => move('CANCELLED', 'Not needed')} disabled={busy}>
                  Cancel request
                </Button>
                <Button onClick={submit} disabled={busy}>
                  <Send /> Submit for approval
                </Button>
              </>
            ) : null}
            {canApprove ? (
              <Button
                variant={canCreate ? 'outline' : 'default'}
                onClick={() => decide('APPROVE')}
                disabled={busy}
                title="Approve as it stands, without sending it through the desk"
              >
                <CheckCircle2 /> Approve now
              </Button>
            ) : null}
          </div>
        ) : null}

        {pending && canCreate && !canApprove ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-sm text-muted-foreground">Waiting for an approver.</p>
            <Button variant="outline" asChild>
              <Link href={`/dashboard/purchases/${detail.id}/edit`}>
                <Pencil /> Edit
              </Link>
            </Button>
            <Button variant="ghost" onClick={() => move('DRAFT')} disabled={busy}>
              <Undo2 /> Withdraw to draft
            </Button>
          </div>
        ) : null}

        {receivable ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-sm text-muted-foreground">
              {detail.status === 'APPROVED'
                ? 'Approved. Stock moves when the goods arrive, not before.'
                : detail.status === 'ORDERED'
                  ? 'With the supplier. Book the delivery in when it arrives.'
                  : 'Part of this order has arrived; the rest is still expected.'}
            </p>
            {canApprove && detail.status === 'APPROVED' ? (
              <Button variant="outline" onClick={() => move('ORDERED')} disabled={busy}>
                <Send /> Mark as ordered
              </Button>
            ) : null}
            {canApprove ? (
              detail.status === 'PARTIALLY_RECEIVED' ? (
                <Button variant="ghost" onClick={() => move('CLOSED', 'Closed short')} disabled={busy}>
                  Close short
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => move('CANCELLED', 'Not needed')} disabled={busy}>
                  Cancel order
                </Button>
              )
            ) : null}
            {canReceive ? (
              <Button asChild>
                <Link href={`/dashboard/purchases/receive?po=${detail.id}`}>
                  <PackageCheck /> Receive goods
                </Link>
              </Button>
            ) : null}
          </div>
        ) : null}

        {detail.status === 'RECEIVED' && canApprove ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-sm text-muted-foreground">Everything on this order has arrived.</p>
            <Button onClick={() => move('CLOSED')} disabled={busy}>
              <CheckCircle2 /> Close order
            </Button>
          </div>
        ) : null}

        {(detail.status === 'CLOSED' || detail.status === 'REJECTED' || detail.status === 'CANCELLED') ||
        (detail.status === 'RECEIVED' && !canApprove) ||
        (pending && !canApprove && !canCreate) ||
        ((detail.status === 'DRAFT' || detail.status === 'RETURNED') && !canCreate && !canApprove) ||
        (receivable && !canApprove && !canReceive) ? (
          <p className="text-sm text-muted-foreground">
            {detail.status === 'CLOSED'
              ? 'Closed.'
              : detail.status === 'REJECTED'
                ? 'Rejected. Raise a new request if the goods are still needed.'
                : detail.status === 'CANCELLED'
                  ? 'Cancelled.'
                  : `${status.label}. Nothing for you to do here.`}
          </p>
        ) : null}
      </section>
    </div>
  )
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:size-3.5">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <div className="truncate text-sm font-medium">{value}</div>
      </div>
    </div>
  )
}
