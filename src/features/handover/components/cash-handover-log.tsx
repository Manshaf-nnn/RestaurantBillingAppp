'use client'

import { ArrowRightLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney } from '@/lib/money'

export interface CashHandoverRow {
  id: string
  fromName: string
  toName: string
  branchName: string | null
  registerName: string | null
  expectedAmount: number
  countedAmount: number
  variance: number
  note: string | null
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED'
  createdAt: string
  acceptedAt: string | null
}

/**
 * Who passed which till to whom, and what was in it.
 *
 * Read-only on purpose. A handover is requested from the drawer screen — where
 * the person is standing with the money — and accepted from the session screen,
 * where the next person is standing with it. Neither belongs here: this is the
 * record, for the manager reading back through the day.
 */
export function CashHandoverLog({
  rows,
  currency,
}: {
  rows: CashHandoverRow[]
  currency: string
}) {
  const money = (m: number) => formatMoney(m, currency)

  if (rows.length === 0) {
    return (
      <SectionCard title="Till handovers">
        <EmptyState
          title="No tills have changed hands"
          description="When a cashier passes their drawer to somebody else mid-service, it is recorded here with both counts."
        />
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title="Till handovers"
      description="Each one closes a drawer and opens the next, so only one person is ever accountable for the cash."
    >
      <ul className="divide-y divide-border">
        {rows.map((h) => (
          <li key={h.id} className="py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ArrowRightLeft className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-medium">
                {h.fromName} → {h.toName}
              </span>
              <span className="text-muted-foreground">
                {[h.branchName, h.registerName].filter(Boolean).join(' · ')}
              </span>
              <Badge
                variant={
                  h.status === 'ACCEPTED'
                    ? 'success'
                    : h.status === 'DECLINED'
                      ? 'destructive'
                      : 'warning'
                }
              >
                {h.status === 'ACCEPTED'
                  ? 'Accepted'
                  : h.status === 'DECLINED'
                    ? 'Declined'
                    : 'Waiting'}
              </Badge>
            </div>
            <p className="mt-1 text-muted-foreground">
              Expected {money(h.expectedAmount)}, counted{' '}
              <span className="font-medium text-foreground tabular-nums">
                {money(h.countedAmount)}
              </span>
              {h.variance !== 0 ? (
                <span className="text-amber-600 dark:text-amber-400">
                  {' '}
                  — {h.variance > 0 ? 'over' : 'short'} by {money(Math.abs(h.variance))}
                </span>
              ) : (
                ' — balanced'
              )}
              . <LocalDateTime value={h.createdAt} />
            </p>
            {h.note ? <p className="mt-1 italic text-muted-foreground">“{h.note}”</p> : null}
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}
