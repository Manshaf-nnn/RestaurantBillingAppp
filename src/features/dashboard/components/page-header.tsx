import * as React from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {/*
        No `shrink-0`. It kept the action row at its natural width, so a header
        with several buttons — Reports, with its export set — pushed past a
        narrow viewport and scrolled the whole page sideways. Allowing it to
        shrink lets `flex-wrap` do its job and stack the buttons instead.
      */}
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}

export function StatCard({
  label,
  value,
  change,
  hint,
  icon,
  tone = 'default',
}: {
  label: string
  value: string | number
  /** Percentage change vs the comparison period. */
  change?: number
  hint?: string
  icon?: React.ReactNode
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'destructive'
}) {
  const positive = change !== undefined && change > 0.5
  const negative = change !== undefined && change < -0.5

  return (
    <div className="rounded-xl border bg-card p-5 shadow-soft transition-shadow hover:shadow-elevated">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {icon ? (
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4',
              tone === 'primary' && 'bg-primary/10 text-primary',
              tone === 'success' && 'bg-success/10 text-success',
              tone === 'warning' && 'bg-warning/15 text-warning',
              tone === 'destructive' && 'bg-destructive/10 text-destructive',
              tone === 'default' && 'bg-muted text-muted-foreground',
            )}
          >
            {icon}
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-2xl font-bold tabular-nums tracking-tight">{value}</p>

      <div className="mt-1.5 flex items-center gap-2 text-xs">
        {change !== undefined ? (
          <span
            className={cn(
              'flex items-center gap-0.5 font-semibold',
              positive && 'text-success',
              negative && 'text-destructive',
              !positive && !negative && 'text-muted-foreground',
            )}
          >
            {positive ? (
              <ArrowUpRight className="size-3.5" />
            ) : negative ? (
              <ArrowDownRight className="size-3.5" />
            ) : (
              <Minus className="size-3.5" />
            )}
            {Math.abs(change).toFixed(1)}%
          </span>
        ) : null}
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  )
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('rounded-xl border bg-card shadow-soft', className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </section>
  )
}
