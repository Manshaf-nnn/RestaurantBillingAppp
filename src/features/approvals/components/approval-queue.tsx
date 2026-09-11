import { Badge } from '@/components/ui/badge'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'

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
 * What was already decided — who asked, who answered, and what they said.
 *
 * ── Why this no longer decides anything ─────────────────────────────────────
 *
 * It used to render a "Waiting for a decision" card above this one, with its
 * own Approve/Reject buttons. Once `/dashboard/approvals` became the central
 * desk, this component was only ever mounted with decided rows and
 * `canDecide={false}` — so that half could not fire, and all it did was print
 * a permanently empty "Nothing waiting" box directly beneath the real queue.
 * On a screen listing five live requests, a box saying nothing was waiting is
 * worse than no box: it reads as the page being broken.
 *
 * Deciding lives in `central-approvals.tsx`, which routes each row to the
 * guarded action that owns its queue. This is now a plain server-rendered
 * history — no client bundle, no second decide path to keep in step.
 */
export function ApprovalQueue({
  rows,
  currency,
}: {
  rows: ApprovalRow[]
  currency: string
}) {
  if (rows.length === 0) return null
  const money = (minor: number) => formatMoney(minor, currency)

  return (
    <SectionCard title="Already decided" description="What was asked, and what was said.">
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
            <Badge
              variant={
                row.status === 'APPROVED' ? 'success'
                  : row.status === 'REJECTED' ? 'destructive' : 'secondary'
              }
            >
              {/* The spec calls it Cancelled; the enum has always called it
                  WITHDRAWN. Relabelled here rather than migrated. */}
              {row.status === 'WITHDRAWN' ? 'cancelled' : row.status.toLowerCase()}
            </Badge>
            <span>{KIND_LABELS[row.kind] ?? row.kind}</span>
            {row.amount !== null && <span className="tabular-nums">{money(row.amount)}</span>}
            <span className="text-muted-foreground">{row.reason}</span>
            {row.decisionNote && (
              <span className="text-xs text-muted-foreground">— {row.decisionNote}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {row.requestedByName ?? 'Unknown'} · <LocalDateTime value={row.requestedAt} />
              {row.branchName ? ` · ${row.branchName}` : ''}
              {row.decidedByName ? ` · decided by ${row.decidedByName}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}
