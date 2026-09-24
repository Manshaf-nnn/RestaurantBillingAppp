'use client'

import * as React from 'react'
import { ShieldAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { Button } from '@/components/ui/button'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { approvalDetailAction } from '../actions'
import { ApprovalDetail } from './approval-detail'
import type { ApprovalDetailPayload } from '../types'

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
  /** Set when the two-person rule was overridden to decide it (§9). */
  forcedAt: string | null
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
 * Deciding lives in `approvals-board.tsx`, which routes each row to the
 * guarded action that owns its queue. This is now a plain server-rendered
 * history — no client bundle, no second decide path to keep in step.
 */
export function ApprovalQueue({
  rows,
  currency,
  locale,
}: {
  rows: ApprovalRow[]
  currency: string
  locale: string
}) {
  /*
   * A client component now, and only for one reason: §9 asks that a request
   * can be opened and read in full before anybody rules on it, and the detail
   * — the payload plus the audit trail of the record it concerns — is far too
   * much to load for every row of a fifty-row history when at most one gets
   * opened. So it is fetched on click, through a guarded read action.
   */
  const [detail, setDetail] = React.useState<ApprovalDetailPayload | null>(null)
  const [loading, setLoading] = React.useState<string | null>(null)

  const open = async (id: string) => {
    setLoading(id)
    const result = await callAction(() => approvalDetailAction({ approvalId: id }))
    setLoading(null)
    if (result.ok) setDetail(result.data)
  }

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
            {/*
              An override stays visible for as long as the record does (§9).
              A decision that broke the two-person rule and looks identical to
              one that did not is a control nobody can audit.
            */}
            {row.forcedAt ? (
              <Badge variant="destructive">
                <ShieldAlert /> overridden
              </Badge>
            ) : null}
            <span className="ml-auto text-xs text-muted-foreground">
              {row.requestedByName ?? 'Unknown'} · <LocalDateTime value={row.requestedAt} />
              {row.branchName ? ` · ${row.branchName}` : ''}
              {row.decidedByName ? ` · decided by ${row.decidedByName}` : ''}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading === row.id}
              onClick={() => void open(row.id)}
            >
              Details
            </Button>
          </li>
        ))}
      </ul>

      <ApprovalDetail
        request={
          detail
            ? { ...detail, kindLabel: KIND_LABELS[detail.kind] ?? detail.kind }
            : null
        }
        currency={currency as CurrencyCode}
        locale={locale}
        open={detail !== null}
        onClose={() => setDetail(null)}
      />
    </SectionCard>
  )
}
