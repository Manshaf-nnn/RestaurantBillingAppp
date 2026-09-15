'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { Download, FileSpreadsheet, FileText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Take this screen away as a file (correctionA.md §1).
 *
 * ── Why one component and not a link per page ──────────────────────────────
 *
 * There is one export endpoint, and it has always taken the filters as query
 * parameters — but only two screens ever linked to it, each building the URL
 * by hand. Hand-built is how an export drifts from the screen above it: a page
 * gains a filter, the link does not learn about it, and somebody is handed a
 * file containing rows they had deliberately excluded. That is worse than no
 * export, because the file looks right.
 *
 * So this reads `useSearchParams()` and forwards **everything** the page is
 * already filtered by — the period, the branch, the search term, whatever gets
 * added next — without knowing what any of it means. The server re-resolves
 * each one against the caller's own permissions, so forwarding a parameter can
 * never widen what comes back.
 *
 * ── It is a plain link on purpose ──────────────────────────────────────────
 *
 * `<a download>` lets the browser do the download: no fetch, no blob, no
 * memory held for a 10,000-row workbook, and the ordinary "this file is
 * downloading" affordance people already understand. `callAction` would give
 * none of that and cannot stream a file anyway.
 */
export function ExportMenu({
  type,
  label = 'Export',
  disabled,
}: {
  /** The endpoint's `?type=` — must be one the route knows. */
  type: string
  label?: string
  /** For a screen with nothing on it: an empty file helps nobody. */
  disabled?: boolean
}) {
  const params = useSearchParams()

  const href = React.useCallback(
    (format: 'csv' | 'xlsx') => {
      const next = new URLSearchParams(params.toString())
      next.set('type', type)
      next.set('format', format)
      return `/api/reports/export?${next.toString()}`
    },
    [params, type],
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Download /> {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>
          <p className="text-sm font-semibold text-foreground">Download</p>
          {/*
            Said plainly, because the alternative assumption — that a download
            gives you everything — is the one people make, and it is the one
            that produces a file quietly missing rows.
          */}
          <p className="text-xs font-normal text-muted-foreground">
            Exactly what is on screen, with the same filters.
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={href('csv')} download>
            <FileText /> CSV
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={href('xlsx')} download>
            <FileSpreadsheet /> Excel
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
