'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

/**
 * How many rows a list shows at once (aO.md §6).
 *
 * Presets for the sizes people actually ask for, and Custom for the one they
 * are about to. The lists used to offer 50 / 100 / All, which answered
 * "twenty-five will do" with fifty and "show me the lot" with a query that
 * could return five thousand rows; neither is a number anybody chose.
 *
 * ── Why there is no "All" any more ─────────────────────────────────────────
 *
 * "All" is not a page size, it is the absence of one, and on a restaurant
 * with three years of orders it is a request the browser cannot render and
 * the database should not be asked for. A ceiling stays — the server clamps
 * whatever is typed — but the number is now the reader's, and it applies to
 * the FILTERED set, so narrowing the period is the way to see everything
 * that matters.
 *
 * The value lives in the URL beside the other filters, so the server
 * component does the narrowing and the figures stay the database's. Changing
 * it goes back to page one: page four of fifty is not page four of ten.
 */

export const ROWS_PER_PAGE_PRESETS = [10, 25, 50, 100, 250, 500] as const

/** The server clamps to this too; typing more is not a way around it. */
export const ROWS_PER_PAGE_MAX = 5000

const CUSTOM = 'custom'

export function RowsPerPage({
  value,
  /** Omitted from the URL when it equals this, so the address stays clean. */
  defaultValue,
  param = 'perPage',
  className,
}: {
  value: number
  defaultValue?: number
  param?: string
  className?: string
}) {
  const router = useRouter()
  const params = useSearchParams()

  const isPreset = (ROWS_PER_PAGE_PRESETS as readonly number[]).includes(value)
  const [custom, setCustom] = React.useState(!isPreset)
  const [draft, setDraft] = React.useState(String(value))

  // A value that changed elsewhere (back button, a link) is the one to show.
  React.useEffect(() => {
    setDraft(String(value))
    setCustom(!(ROWS_PER_PAGE_PRESETS as readonly number[]).includes(value))
  }, [value])

  const apply = (rows: number) => {
    const clamped = Math.min(ROWS_PER_PAGE_MAX, Math.max(1, Math.trunc(rows)))
    const next = new URLSearchParams(params.toString())
    if (defaultValue !== undefined && clamped === defaultValue) next.delete(param)
    else next.set(param, String(clamped))
    // A different page size means different pages; start at the first.
    next.delete('page')
    router.push(`?${next.toString()}`)
  }

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed) || parsed < 1) {
      setDraft(String(value))
      return
    }
    if (Math.min(ROWS_PER_PAGE_MAX, Math.trunc(parsed)) === value) return
    apply(parsed)
  }

  return (
    <div className={className ?? 'flex items-center gap-2'}>
      <Select
        value={custom ? CUSTOM : String(value)}
        onValueChange={(next) => {
          if (next === CUSTOM) {
            setCustom(true)
            return
          }
          setCustom(false)
          apply(Number(next))
        }}
      >
        <SelectTrigger className="w-36" aria-label="Rows per page">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROWS_PER_PAGE_PRESETS.map((option) => (
            <SelectItem key={option} value={String(option)}>{option} rows</SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>

      {custom ? (
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={ROWS_PER_PAGE_MAX}
          className="w-24"
          aria-label="Rows per page, exactly"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
        />
      ) : null}
    </div>
  )
}
