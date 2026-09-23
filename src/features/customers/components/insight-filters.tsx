'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Users } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchBox } from '@/components/search-box'

/**
 * The same filter vocabulary as the customer list (pro.A.md §3).
 *
 * Its own component rather than a copy of the list's bar, because the two
 * screens answer different halves of one question — "who are they" and "what
 * are they worth" — and a filter that means one thing on one and something
 * else on the other is worse than no filter. Both write the same URL
 * parameters, which the server turns into the same `CustomerSegment`.
 *
 * There is no discount button here: aiming an offer belongs where the people
 * are listed, so nobody fires one at a group they have not looked at.
 */
export function InsightFilters({
  categories,
  currency,
  reaches,
}: {
  categories: Array<{ id: string; name: string }>
  currency: string
  reaches: number
}) {
  const router = useRouter()
  const params = useSearchParams()

  const value = (key: string) => params.get(key) ?? ''
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [key, v] of Object.entries(patch)) {
      if (v) next.set(key, v)
      else next.delete(key)
    }
    router.replace(`?${next.toString()}`)
  }
  const keys = ['q', 'category', 'kind', 'minVisits', 'minSpent', 'notSeenForDays', 'minPoints']
  const active = keys.some((key) => value(key))
  const select = 'h-9 rounded-lg border border-input bg-background px-2 text-sm'

  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-wrap items-end gap-2" data-testid="insight-filters">
        <SearchBox
          placeholder="Name, phone or email…"
          paramName="q"
          defaultValue={value('q')}
          className="w-full sm:w-56"
        />
        {categories.length > 0 ? (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="if-category">Category</label>
            <select
              id="if-category"
              className={select}
              value={value('category')}
              onChange={(event) => set({ category: event.target.value })}
            >
              <option value="">Any category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="if-kind">Who</label>
          <select
            id="if-kind"
            className={select}
            value={value('kind')}
            onChange={(event) => set({ kind: event.target.value })}
          >
            <option value="">Everybody</option>
            <option value="new">New (1 visit)</option>
            <option value="returning">Returning (2+)</option>
            <option value="repeat">Repeat (3+)</option>
            <option value="regular">Regular (5+, seen recently)</option>
            <option value="lapsed">Lapsed (2+, away 45 days)</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="if-visits">Visits at least</label>
          <Input
            id="if-visits"
            type="number"
            className="h-9 w-28"
            defaultValue={value('minVisits')}
            onBlur={(event) => set({ minVisits: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="if-spent">
            Spent at least ({currency})
          </label>
          <Input
            id="if-spent"
            type="number"
            className="h-9 w-32"
            defaultValue={value('minSpent')}
            onBlur={(event) => set({ minSpent: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="if-away">Away for (days)</label>
          <Input
            id="if-away"
            type="number"
            className="h-9 w-28"
            defaultValue={value('notSeenForDays')}
            onBlur={(event) => set({ notSeenForDays: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="if-points">Points at least</label>
          <Input
            id="if-points"
            type="number"
            className="h-9 w-28"
            defaultValue={value('minPoints')}
            onBlur={(event) => set({ minPoints: event.target.value })}
          />
        </div>
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              set({ q: '', category: '', kind: '', minVisits: '', minSpent: '', notSeenForDays: '', minPoints: '' })
            }
          >
            Clear
          </Button>
        ) : null}
      </div>

      {active ? (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <Users className="size-4 text-muted-foreground" />
          <span>
            <strong>{reaches.toLocaleString()}</strong> customer{reaches === 1 ? '' : 's'} match.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => router.push(`/dashboard/customers?${params.toString()}`)}
          >
            Open the list to offer them something
          </Button>
        </p>
      ) : null}
    </div>
  )
}
