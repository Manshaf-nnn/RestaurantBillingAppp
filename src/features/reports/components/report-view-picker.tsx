'use client'

import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { cn } from '@/lib/utils'

/**
 * Which breakdown a report is showing.
 *
 * ── Why a report needs this at all ──────────────────────────────────────────
 *
 * The sales report stacked eight tables down one page — payment method, item,
 * category, location, employee, hour, day — and rendered every one of them on
 * every load. An owner who wanted to know what sold well scrolled past four
 * tables to reach it, and the page computed the other seven anyway.
 *
 * So the breakdown is a choice now, and it lives in the URL like every other
 * filter on these screens: the view is shareable, survives a refresh, and the
 * back button does what it looks like it does.
 *
 * Selection only, no state: the page reads `?view=` and renders one thing.
 */
export function ReportViewPicker({
  views,
  active,
  param = 'view',
}: {
  views: Array<{ value: string; label: string }>
  active: string
  /** The search param that carries it, for a page with more than one picker. */
  param?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const go = (value: string) => {
    const next = new URLSearchParams(params.toString())
    if (value === views[0]?.value) next.delete(param)
    else next.set(param, value)
    /*
     * Changing the breakdown drops whichever row was drilled into. Keeping it
     * would leave "payments for Pizza" showing while the picker says "By hour".
     */
    next.delete('item')
    const search = next.toString()
    router.push(search ? `${pathname}?${search}` : pathname, { scroll: false })
  }

  return (
    <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="Breakdown">
      {views.map((view) => (
        <button
          key={view.value}
          type="button"
          role="tab"
          aria-selected={view.value === active}
          onClick={() => go(view.value)}
          className={cn(
            'rounded-lg border px-3 py-1.5 text-sm transition',
            view.value === active
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border hover:bg-muted',
          )}
        >
          {view.label}
        </button>
      ))}
    </div>
  )
}
