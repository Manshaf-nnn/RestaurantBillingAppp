'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Building2 } from 'lucide-react'

/**
 * The owner's location filter.
 *
 * Written to the URL rather than component state so the choice survives a
 * refresh, can be bookmarked, and is readable by the server components that
 * actually do the filtering — the figures are narrowed in the query, not hidden
 * in the browser.
 */
export function LocationSwitcher({
  locations,
  current,
}: {
  locations: Array<{ id: string; name: string; type: string }>
  current: string | null
}) {
  const router = useRouter()
  const params = useSearchParams()

  if (locations.length < 2) return null

  const change = (value: string) => {
    const next = new URLSearchParams(params.toString())
    if (value) next.set('branch', value)
    else next.delete('branch')
    router.push(`?${next.toString()}`)
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <Building2 className="h-4 w-4 text-muted-foreground" />
      <span className="sr-only">Location</span>
      <select
        className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
        value={current ?? ''}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">All locations</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
            {l.type !== 'BRANCH' ? ` · ${l.type.replace(/_/g, ' ').toLowerCase()}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
