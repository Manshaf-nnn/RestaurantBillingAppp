'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { decideApprovalAction } from '../actions'
import { callAction } from '@/lib/use-action'

export interface ApprovalRow {
  id: string
  kind: string
  status: string
  entity: string
  amount: number | null
  reason: string
  requestedByName: string | null
  decidedByName: string | null
  branchName: string | null
  requestedAt: string
  decisionNote: string | null
}

const KIND_LABELS: Record<string, string> = {
  REFUND: 'Refund',
  DISCOUNT: 'Discount',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  PURCHASE_ORDER: 'Purchase order',
  STOCK_TRANSFER: 'Transfer',
  PRICE_OVERRIDE: 'Price override',
}

/**
 * The approval queue.
 *
 * Pending requests sit at the top with the amount that triggered them in plain
 * view, because the figure is the whole reason the request exists. A note is
 * offered on rejection rather than approval: saying yes needs no explanation,
 * saying no does.
 */
export function ApprovalQueue({
  rows,
  currency,
  canDecide,
}: {
  rows: ApprovalRow[]
  currency: string
  canDecide: boolean
}) {
  const router = useRouter()
  const money = (m: number) => formatMoney(m, currency)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [notes, setNotes] = React.useState<Record<string, string>>({})

  const decide = async (id: string, approve: boolean) => {
    setBusy(id)
    const result = await callAction(() => decideApprovalAction({ approvalId: id, approve, note: notes[id] ?? '' }))
    setBusy(null)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(approve ? 'Approved' : 'Rejected')
    router.refresh()
  }

  const pending = rows.filter((r) => r.status === 'PENDING')
  const decided = rows.filter((r) => r.status !== 'PENDING')

  return (
    <div className="space-y-5">
      <SectionCard
        title="Waiting for a decision"
        description="Nothing here has happened yet — these are requests, and the action only goes ahead once approved."
        actions={pending.length > 0 ? <Badge variant="warning">{pending.length}</Badge> : null}
      >
        {pending.length === 0 ? (
          <EmptyState title="Nothing waiting" description="Requests above your thresholds appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {pending.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="secondary">{KIND_LABELS[r.kind] ?? r.kind}</Badge>
                  {r.amount !== null && (
                    <span className="font-semibold tabular-nums">{money(r.amount)}</span>
                  )}
                  <span className="text-muted-foreground">{r.reason}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.requestedByName ?? 'Unknown'} · <LocalDateTime value={r.requestedAt} />
                    {r.branchName ? ` · ${r.branchName}` : ''}
                  </span>
                </div>

                {canDecide && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      className="max-w-xs"
                      placeholder="Note (needed if you reject)"
                      value={notes[r.id] ?? ''}
                      onChange={(e) => setNotes((c) => ({ ...c, [r.id]: e.target.value }))}
                    />
                    <Button size="sm" onClick={() => decide(r.id, true)} disabled={busy === r.id}>
                      <Check className="mr-1.5 h-4 w-4" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => decide(r.id, false)}
                      disabled={busy === r.id}
                    >
                      <X className="mr-1.5 h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {decided.length > 0 && (
        <SectionCard title="Decided" description="What was asked, and what was said.">
          <ul className="divide-y divide-border">
            {decided.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                <Badge
                  variant={
                    r.status === 'APPROVED' ? 'success'
                      : r.status === 'REJECTED' ? 'destructive' : 'secondary'
                  }
                >
                  {r.status.toLowerCase()}
                </Badge>
                <span>{KIND_LABELS[r.kind] ?? r.kind}</span>
                {r.amount !== null && <span className="tabular-nums">{money(r.amount)}</span>}
                <span className="text-muted-foreground">{r.reason}</span>
                {r.decisionNote && (
                  <span className="text-xs text-muted-foreground">— {r.decisionNote}</span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {r.decidedByName ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  )
}
