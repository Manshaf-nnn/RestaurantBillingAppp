'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { CalendarRange } from 'lucide-react'
import { useState } from 'react'

import { Input } from '@/components/ui/input'
import { DASHBOARD_PRESETS, RANGE_LABELS, type RangePreset } from '@/features/reports/range'

/**
 * Which period the dashboard is showing.
 *
 * ── The same URL convention as the reports, deliberately ────────────────────
 *
 * `?preset=` with `?from=&to=` for custom, exactly as `ReportFilters` does.
 * There are already four conventions for this idea in the app — `?range=` in
 * two different casings, `?days=<int>`, and this one — and the dashboard joins
 * the most capable of them rather than inventing a fifth. The server resolves
 * the value; nothing here decides what "this month" means.
 *
 * State in the URL rather than in React means a period can be bookmarked or
 * sent to somebody, the back button works, and — the part that matters — the
 * server components read the same parameter and narrow the actual SQL. A
 * selector that only filtered in the browser would be the decorative-control
 * failure the branch switcher already had.
 *
 * ── Why the custom inputs are behind a toggle ───────────────────────────────
 *
 * Two date fields permanently on screen suggest they are the primary control.
 * They are not: seven presets answer the question almost every time. They open
 * on demand, and stay open when a custom range is already active, so an owner
 * who has one can see and adjust it.
 */
export function PeriodPicker({
  preset,
  from,
  to,
  label,
}: {
  preset: string
  from: string
  to: string
  /** What the server actually resolved, e.g. "1 – 24 Aug". */
  label: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [showCustom, setShowCustom] = useState(preset === 'CUSTOM')

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    // `scroll: false` because the dashboard is long and jumping to the top
    // after changing a period loses the card you were reading.
    router.push(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {DASHBOARD_PRESETS.map((p: RangePreset) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setShowCustom(false)
              set({ preset: p, from: null, to: null })
            }}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
              preset === p
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border hover:bg-muted'
            }`}
          >
            {RANGE_LABELS[p]}
          </button>
        ))}

        <button
          type="button"
          onClick={() => setShowCustom((open) => !open)}
          aria-expanded={showCustom}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
            preset === 'CUSTOM'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border hover:bg-muted'
          }`}
        >
          <CalendarRange className="size-3.5" />
          Custom
        </button>
      </div>

      {showCustom ? (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-muted/40 p-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="period-from">
              From
            </label>
            <Input
              id="period-from"
              type="date"
              className="h-9 w-40"
              value={from}
              max={to || undefined}
              onChange={(e) =>
                // Seed `to` with the same day, so picking only a start gives a
                // valid one-day range instead of being silently ignored by the
                // resolver, which needs both.
                set({ preset: 'CUSTOM', from: e.target.value, to: to || e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="period-to">
              To
            </label>
            <Input
              id="period-to"
              type="date"
              className="h-9 w-40"
              value={to}
              min={from || undefined}
              onChange={(e) =>
                set({ preset: 'CUSTOM', from: from || e.target.value, to: e.target.value })
              }
            />
          </div>
          <p className="pb-2 text-xs text-muted-foreground">Showing {label}</p>
        </div>
      ) : null}
    </div>
  )
}
