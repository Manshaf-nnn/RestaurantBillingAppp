import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * The frame every report drill-down wears.
 *
 * A server component with no state of its own: breadcrumb, title, the filter
 * bar the page passes in, one table, and a footer. Several screens share it so
 * the columns are the only thing that differs between them — which is the
 * point of a drill-down, and the reason they cannot drift apart in spacing,
 * heading weight or empty-state wording.
 *
 * `parent` is the report the breadcrumb goes back to. It used to be the
 * inventory report, written into the markup, which was right while inventory
 * was the only report with drill-downs and wrong the moment purchasing got
 * some: every one of its tables offered to take the reader back to a screen
 * they had not come from. It defaults to inventory so the four screens that
 * were here first did not have to change.
 */
export function DrillDown({
  title,
  description,
  parent = { href: '/dashboard/reports/inventory', label: 'Inventory Reports' },
  filters,
  actions,
  footer,
  children,
}: {
  title: string
  description: string
  parent?: { href: string; label: string }
  /** The date-range and location controls, built by the page (server reads). */
  filters?: React.ReactNode
  actions?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <>
      <nav className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link
          href={parent.href}
          className="inline-flex items-center gap-1.5 hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {parent.label}
        </Link>
      </nav>

      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>

      {filters ? <div className="mb-4">{filters}</div> : null}

      <section className="overflow-hidden rounded-xl border bg-card shadow-soft">
        <div className="overflow-x-auto">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
            {footer}
          </div>
        ) : null}
      </section>
    </>
  )
}

/** The one table shape the drill-downs use. */
export function DrillTable({
  columns,
  children,
  empty,
  isEmpty,
}: {
  columns: Array<{ label: string; align?: 'right' | 'center' }>
  children: React.ReactNode
  empty: string
  isEmpty: boolean
}) {
  if (isEmpty) {
    return <p className="px-4 py-12 text-center text-sm text-muted-foreground">{empty}</p>
  }
  return (
    <table className="w-full min-w-[48rem] text-sm">
      <thead>
        <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          {columns.map((column, index) => (
            <th
              key={index}
              className={cn(
                'px-4 py-3 font-medium',
                column.align === 'right' && 'text-right',
                column.align === 'center' && 'text-center',
              )}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y">{children}</tbody>
    </table>
  )
}

/**
 * Page links, as plain anchors.
 *
 * Server-rendered hrefs rather than a click handler: the page is already a
 * server component reading `?page=`, so a link is the whole mechanism and
 * the result is shareable, bookmarkable and works before hydration.
 *
 * ── The contract, which was implicit and is now written down ────────────────
 *
 * THE CALLER SLICES. This renders the links and the "1–10 of 240" line from
 * the numbers it is given; it never sees the rows and cannot narrow them.
 * Hand the table every row while handing this a `total` and a `page` and the
 * result is quietly wrong in the worst way — the footer says "1–10 of 240",
 * the links all work, and the table above shows all 240 with no sign that
 * anything is amiss.
 *
 * `paginate()` in `features/reports/inventory-drill` returns the slice and
 * these numbers together, which is the way to be sure they agree. The second
 * caller of this component noticed the contract was unstated; that is exactly
 * the moment to state it rather than the moment after somebody gets it wrong.
 */
export function Pager({
  page,
  pageCount,
  hrefFor,
  /** The rows in the WHOLE report, not in the slice on screen. */
  total,
  perPage,
}: {
  page: number
  pageCount: number
  hrefFor: (page: number) => string
  total: number
  perPage: number
}) {
  if (pageCount <= 1) {
    return (
      <>
        <span>
          {total} {total === 1 ? 'row' : 'rows'}
        </span>
        <span />
      </>
    )
  }

  // First, last, and a window around the current page — with gaps marked so a
  // long report does not render fifty numbered links.
  const pages = new Set<number>([1, pageCount, page, page - 1, page + 1])
  const shown = [...pages].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b)

  return (
    <>
      <span>
        {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
      </span>
      <span className="flex items-center gap-1">
        {shown.map((n, index) => (
          <React.Fragment key={n}>
            {index > 0 && n - shown[index - 1] > 1 ? <span className="px-1">…</span> : null}
            <Link
              href={hrefFor(n)}
              aria-current={n === page ? 'page' : undefined}
              className={cn(
                'flex size-8 items-center justify-center rounded-md text-sm tabular-nums transition-colors',
                n === page
                  ? 'bg-primary font-semibold text-primary-foreground'
                  : 'hover:bg-muted hover:text-foreground',
              )}
            >
              {n}
            </Link>
          </React.Fragment>
        ))}
      </span>
    </>
  )
}
