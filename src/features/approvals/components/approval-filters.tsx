'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FilterX } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ItemPicker } from '@/components/ui/item-picker'

/**
 * Narrowing the approvals history (correctionA.md §9).
 *
 * ── Why From and To are two controls and not one ───────────────────────────
 *
 * §9 asks for both directions and for the combination: From = Kandy shows what
 * Kandy is giving up, To = Jaffna what Jaffna is receiving, and the two
 * together the single lane between them. A single "location" filter cannot
 * express that third question, which is the one an owner asks when two sites
 * disagree about a transfer.
 *
 * They mean something only for a transfer — nothing else has two ends — and
 * the To control says so rather than silently returning nothing for a refund.
 *
 * State lives in the URL, like the period picker and the branch switcher, so
 * the server narrows the actual query rather than the browser hiding rows. A
 * filter that only hides is a filter that lies about how many there are.
 */
export function ApprovalFilters({
  locations,
  staff,
  kinds,
  statuses,
}: {
  locations: Array<{ id: string; name: string }>
  staff: Array<{ id: string; name: string; roleLabel: string; branchName: string | null }>
  kinds: Array<{ value: string; label: string }>
  statuses: Array<{ value: string; label: string }>
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
    router.push(`?${next.toString()}`, { scroll: false })
  }

  const FILTER_KEYS = ['from', 'to', 'status', 'kind', 'requestedBy', 'fromBranch', 'toBranch']
  const active = FILTER_KEYS.filter((key) => value(key))

  const locationOptions = locations.map((l) => ({ value: l.id, label: l.name }))

  return (
    <div className="mb-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
        {/*
          A date range (recorrection.md §1) — on both lists: when a request was
          raised is the first thing anyone narrows a busy desk by.
        */}
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="approvals-from">From date</Label>
          <Input
            id="approvals-from"
            type="date"
            value={value('from')}
            max={value('to') || undefined}
            onChange={(event) => set({ from: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="approvals-to">To date</Label>
          <Input
            id="approvals-to"
            type="date"
            value={value('to')}
            min={value('from') || undefined}
            onChange={(event) => set({ to: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Status</Label>
          <ItemPicker
            options={statuses}
            value={value('status')}
            onChange={(v) => set({ status: v })}
            placeholder="Any status"
            clearable
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Type</Label>
          <ItemPicker
            options={kinds}
            value={value('kind')}
            onChange={(v) => set({ kind: v })}
            placeholder="Any type"
            clearable
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Requested by</Label>
          <ItemPicker
            options={staff.map((s) => ({
              value: s.id,
              label: s.name,
              hint: `${s.roleLabel} — ${s.branchName ?? 'no location set'}`,
            }))}
            value={value('requestedBy')}
            onChange={(v) => set({ requestedBy: v })}
            placeholder="Anyone"
            searchPlaceholder="Search staff…"
            clearable
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">From location</Label>
          <ItemPicker
            options={locationOptions}
            value={value('fromBranch')}
            onChange={(v) => set({ fromBranch: v })}
            placeholder="Anywhere"
            clearable
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">
            To location <span className="font-normal text-muted-foreground">(transfers)</span>
          </Label>
          <ItemPicker
            options={locationOptions}
            value={value('toBranch')}
            onChange={(v) => set({ toBranch: v })}
            placeholder="Anywhere"
            clearable
          />
        </div>
      </div>

      {active.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {active.length} filter{active.length === 1 ? '' : 's'} on
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])))}
          >
            <FilterX /> Clear
          </Button>
        </div>
      ) : null}
    </div>
  )
}
