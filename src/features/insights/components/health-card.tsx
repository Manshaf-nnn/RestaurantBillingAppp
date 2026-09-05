import Link from 'next/link'
import { AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { cn } from '@/lib/utils'
import { BAND_META, WEIGHTS, type HealthScore } from '../health'

const SIGNALS = Object.keys(WEIGHTS).length

/** The health score and the three things to look at first (smart.md §8). Server component. */
export function HealthCard({ health }: { health: HealthScore }) {
  const band = health.band ? BAND_META[health.band] : null
  return (
    <SectionCard
      title="Restaurant health"
      description={
        health.score === null
          ? 'Not enough activity in this period to score yet.'
          : `Based on ${health.signalsUsed} of ${SIGNALS} signals for this period. 80 and above is healthy.`
      }
    >
      <div className="flex flex-wrap items-center gap-5">
        <p
          className={cn(
            'text-5xl font-bold tabular-nums tracking-tight',
            band?.tone === 'success' && 'text-success',
            band?.tone === 'warning' && 'text-warning',
            band?.tone === 'destructive' && 'text-destructive',
          )}
        >
          {health.score ?? '—'}
          {health.score !== null ? <span className="text-lg font-medium text-muted-foreground"> / 100</span> : null}
        </p>
        {band ? (
          <Badge variant={band.tone} size="lg">
            {band.label}
          </Badge>
        ) : null}
      </div>

      {health.issues.length > 0 ? (
        <div className="mt-4 grid gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What to look at first
          </p>
          {health.issues.map((issue) => {
            const severe = (issue.score ?? 100) < 60
            return (
              <Link
                key={issue.key}
                href={issue.href}
                className={cn(
                  'flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors',
                  severe
                    ? 'border-destructive/40 bg-destructive/5 hover:bg-destructive/10'
                    : 'border-warning/40 bg-warning/5 hover:bg-warning/10',
                )}
              >
                <AlertTriangle className={cn('size-5 shrink-0', severe ? 'text-destructive' : 'text-warning')} />
                <span className="min-w-0 flex-1 text-sm">
                  <strong>{issue.label}</strong> — {issue.detail}
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            )
          })}
        </div>
      ) : health.score !== null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-success" /> Every signal is at its best for this period.
        </p>
      ) : null}

      <details className="mt-4 rounded-lg border border-dashed border-border p-3 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground">How this is scored</summary>
        <ul className="mt-2 grid gap-1.5">
          {health.components.map((component) => (
            <li key={component.key} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="font-medium">{component.label}</span>
                <span className="text-muted-foreground"> · weight {component.weight}</span>
                <span className="block text-muted-foreground">{component.detail}</span>
              </span>
              <span className="font-semibold tabular-nums">
                {component.score === null ? 'not scored' : `${component.score}`}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-muted-foreground">
          Score = weighted average of the scored signals. Sales and profit are trends against the previous
          period; food cost is the level against your target; waste is its share of the ingredient cost of
          what sold; stock is the share of items low or out; books is the checks and identities. Nothing here
          is estimated — every signal is one of the report figures.
        </p>
      </details>
    </SectionCard>
  )
}
