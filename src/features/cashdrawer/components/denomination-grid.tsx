'use client'

import * as React from 'react'

import { Input } from '@/components/ui/input'

/**
 * A grid of counts, not a total box (correctionA.md §4; shifthandover.md
 * "Cash drawer — critical").
 *
 * Two things follow from counting this way rather than typing a sum. The
 * arithmetic stops being the cashier's — "six 500s and four 100s" is a fact
 * about the drawer, where "3,400" is a fact plus a sum, and the sum is where
 * the mistakes live. And a disputed close becomes checkable afterwards: "the
 * drawer was 2,000 short" is an accusation, "there were four 500s where the
 * count says six" is a conversation.
 *
 * One component, used by the drawer's own Close and by the shift handover, so
 * the two ways of ending a till cannot drift into counting differently.
 */
export interface DenominationOption {
  /** Face value in minor units. */
  value: number
  label: string
  kind: 'note' | 'coin'
}

/** Face value (as a string key) → what was typed. Digits only. */
export type DenominationCounts = Record<string, string>

export function countsToNumbers(counts: DenominationCounts): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [value, raw] of Object.entries(counts)) {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0) out[value] = n
  }
  return out
}

export function physicalTotal(denominations: DenominationOption[], counts: DenominationCounts): number {
  return denominations.reduce((sum, d) => sum + d.value * (Number(counts[String(d.value)] ?? '') || 0), 0)
}

export function DenominationGrid({
  denominations,
  counts,
  onChange,
  money,
  idPrefix = 'count',
}: {
  denominations: DenominationOption[]
  counts: DenominationCounts
  onChange: (next: DenominationCounts) => void
  money: (minor: number) => string
  idPrefix?: string
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="denomination-grid">
      {denominations.map((d) => (
        <div key={d.value} className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
            {d.label}
            <span className="ml-1 text-[10px] uppercase">{d.kind === 'coin' ? 'c' : ''}</span>
          </span>
          <span className="text-muted-foreground">×</span>
          <Input
            id={`${idPrefix}-${d.value}`}
            inputMode="numeric"
            placeholder="0"
            aria-label={`How many ${d.label} ${d.kind}s`}
            value={counts[String(d.value)] ?? ''}
            onChange={(e) => onChange({ ...counts, [String(d.value)]: e.target.value.replace(/\D/g, '') })}
            className="h-9"
          />
          <span className="w-24 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
            {money(d.value * (Number(counts[String(d.value)] ?? '') || 0))}
          </span>
        </div>
      ))}
    </div>
  )
}
