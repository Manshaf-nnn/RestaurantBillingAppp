'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RANGE_LABELS, type RangePreset } from '../range'

const PRESETS: RangePreset[] = [
  'TODAY', 'YESTERDAY', 'THIS_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'LAST_7', 'LAST_30',
]

/**
 * Date and location filters for a report.
 *
 * State lives in the URL so a report can be bookmarked, shared with an
 * accountant, and re-read by the server components that actually narrow the
 * query — the figures are filtered in the database, not hidden in the browser.
 */
export function ReportFilters({
  preset,
  from,
  to,
  locations,
  branchId,
  onExport,
}: {
  preset: string
  from: string
  to: string
  locations: Array<{ id: string; name: string }>
  branchId: string | null
  onExport?: () => void
}) {
  const router = useRouter()
  const params = useSearchParams()

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    router.push(`?${next.toString()}`)
  }

  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => set({ preset: p, from: null, to: null })}
            className={`rounded-lg border px-3 py-1.5 text-sm transition ${
              preset === p
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border hover:bg-muted'
            }`}
          >
            {RANGE_LABELS[p]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="from">From</label>
          <Input
            id="from"
            type="date"
            className="w-40"
            value={from}
            onChange={(e) => set({ preset: 'CUSTOM', from: e.target.value, to: to || e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="to">To</label>
          <Input
            id="to"
            type="date"
            className="w-40"
            value={to}
            onChange={(e) => set({ preset: 'CUSTOM', from: from || e.target.value, to: e.target.value })}
          />
        </div>

        {locations.length > 1 && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="branch">Location</label>
            <select
              id="branch"
              className="h-10 rounded-lg border border-input bg-background px-2 text-sm"
              value={branchId ?? ''}
              onChange={(e) => set({ branch: e.target.value || null })}
            >
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        )}

        {onExport && (
          <Button variant="outline" onClick={onExport} className="ml-auto">
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        )}
      </div>
    </div>
  )
}
