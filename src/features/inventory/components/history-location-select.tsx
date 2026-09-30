'use client'

import { useRouter, useSearchParams } from 'next/navigation'

/**
 * Which location an item's history is showing.
 *
 * The same `?branch=` every report page speaks, so the export button beside
 * it — which forwards the query — downloads exactly the rows on screen. Only
 * rendered for somebody who can see more than one location; for everyone else
 * the page is already narrowed to the one they have.
 */
export function HistoryLocationSelect({
  locations,
  value,
}: {
  locations: Array<{ id: string; name: string }>
  value: string | null
}) {
  const router = useRouter()
  const params = useSearchParams()

  return (
    <select
      aria-label="Location"
      className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
      value={value ?? ''}
      onChange={(event) => {
        const next = new URLSearchParams(params.toString())
        if (event.target.value) next.set('branch', event.target.value)
        else next.delete('branch')
        const query = next.toString()
        router.push(query ? `?${query}` : '?')
      }}
    >
      <option value="">All locations</option>
      {locations.map((location) => (
        <option key={location.id} value={location.id}>
          {location.name}
        </option>
      ))}
    </select>
  )
}
