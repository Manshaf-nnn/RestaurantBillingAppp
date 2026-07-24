import * as React from 'react'
import { AlertCircle, Inbox } from 'lucide-react'

import { cn } from '@/lib/utils'

/** Shimmering placeholder used while server data streams in. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton', className)} {...props} />
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className="h-3.5"
          style={{ width: `${100 - index * 12}%` }}
        />
      ))}
    </div>
  )
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('surface space-y-4 p-6', className)}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-8 w-1/2" />
      <SkeletonText lines={2} />
    </div>
  )
}

export function SkeletonTable({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="surface divide-y">
      <div className="flex gap-4 px-4 py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 px-4 py-4">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

export interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

/** The empty state every list falls back to — never a blank screen. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex animate-fade-up flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center',
        className,
      )}
    >
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-7">
        {icon ?? <Inbox />}
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-sm text-balance text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  action,
  className,
}: Omit<EmptyStateProps, 'icon' | 'title'> & { title?: string }) {
  return (
    <EmptyState
      className={cn('border-destructive/30 bg-destructive/5', className)}
      icon={<AlertCircle className="text-destructive" />}
      title={title}
      description={description}
      action={action}
    />
  )
}

export function Alert({
  variant = 'info',
  title,
  children,
  className,
}: {
  variant?: 'info' | 'success' | 'warning' | 'destructive'
  title?: string
  children?: React.ReactNode
  className?: string
}) {
  const styles = {
    info: 'border-chart-2/30 bg-chart-2/5 text-chart-2',
    success: 'border-success/30 bg-success/5 text-success',
    warning: 'border-warning/40 bg-warning/10 text-warning',
    destructive: 'border-destructive/30 bg-destructive/5 text-destructive',
  }[variant]

  return (
    <div className={cn('rounded-lg border px-4 py-3 text-sm', styles, className)} role="alert">
      {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
      {children ? <div className="text-foreground/80">{children}</div> : null}
    </div>
  )
}
