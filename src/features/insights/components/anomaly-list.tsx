import Link from 'next/link'
import { AlertTriangle, ArrowRight, ShieldCheck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { cn } from '@/lib/utils'
import type { Anomaly } from '../queries'

/**
 * Anomaly alerts (smart.md §7): the pattern checks that found something, each
 * a link to a record. Flag for review only — the checker never changes a
 * financial record, and neither does this list. Server component.
 */
export function AnomalyList({ anomalies, checksRun }: { anomalies: Anomaly[]; checksRun: number }) {
  return (
    <SectionCard
      title="Needs review"
      description={`${checksRun} checks ran just now. Flagged for a person to look at — nothing is changed automatically.`}
      actions={
        <Link
          href="/dashboard/accounting/reconciliation"
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          All checks
        </Link>
      }
    >
      {anomalies.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4 text-success" /> Nothing unusual: discounts, refunds, cancellations,
          adjustments, waste and cash all sit inside the house pattern.
        </p>
      ) : (
        <ul className="grid gap-2">
          {anomalies.map((anomaly) => {
            const severe = anomaly.status === 'ERROR'
            return (
              <li key={anomaly.key}>
                <Link
                  href={anomaly.href}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors',
                    severe
                      ? 'border-destructive/40 bg-destructive/5 hover:bg-destructive/10'
                      : 'border-warning/40 bg-warning/5 hover:bg-warning/10',
                  )}
                >
                  <AlertTriangle className={cn('mt-0.5 size-5 shrink-0', severe ? 'text-destructive' : 'text-warning')} />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong>{anomaly.label}</strong>
                      <Badge variant={severe ? 'destructive' : 'warning'} size="sm">
                        {anomaly.count} {anomaly.count === 1 ? 'record' : 'records'}
                      </Badge>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{anomaly.advice}</span>
                  </span>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </SectionCard>
  )
}
