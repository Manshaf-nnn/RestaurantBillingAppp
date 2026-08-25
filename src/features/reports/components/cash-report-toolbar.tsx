'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Download, Printer } from 'lucide-react'

import { Button } from '@/components/ui/button'

/**
 * The filters the cash reports need on top of the shared ones.
 *
 * ── Why this is not folded into `ReportFilters` ─────────────────────────────
 *
 * Cashier, till, status and transaction type mean nothing on the sales or
 * purchasing reports, and a filter bar that offers empty menus on four screens
 * out of six teaches people to ignore it. This sits underneath the shared bar
 * and speaks the same language: every choice is a URL param, so the whole
 * filtered view stays bookmarkable and the server re-reads it.
 *
 * ── Export and print ────────────────────────────────────────────────────────
 *
 * Export is a link, not a button with a handler. `ReportFilters` already has an
 * `onExport` prop and it is dead code, because a Server Component cannot pass a
 * function to a client one — the same hazard that once left five report pages
 * returning 500s. A link carrying the current search params cannot have that
 * problem and has the useful side effect of being right-clickable.
 *
 * Print is the PDF path too. Every browser's Save-as-PDF renders the print
 * stylesheet, which means one document to maintain instead of a second layout
 * inside a PDF library that would drift from this one within a month.
 */
export function CashReportToolbar({
  cashiers,
  registers,
  statuses,
  categories,
  exportQuery,
}: {
  cashiers?: Array<{ id: string; name: string }>
  registers?: Array<{ id: string; name: string }>
  statuses?: Array<{ value: string; label: string }>
  categories?: string[]
  exportQuery: string
}) {
  const router = useRouter()
  const params = useSearchParams()

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    router.push(`?${next.toString()}`)
  }

  return (
    <div className="mb-6 flex flex-wrap items-end gap-3 print:hidden">
      {cashiers && cashiers.length > 0 && (
        <Picker
          label="Cashier"
          value={params.get('cashier') ?? ''}
          onChange={(v) => set('cashier', v)}
          all="Everyone"
          options={cashiers.map((c) => ({ value: c.id, label: c.name }))}
        />
      )}

      {registers && registers.length > 1 && (
        <Picker
          label="Till"
          value={params.get('register') ?? ''}
          onChange={(v) => set('register', v)}
          all="Every till"
          options={registers.map((r) => ({ value: r.id, label: r.name }))}
        />
      )}

      {statuses && statuses.length > 0 && (
        <Picker
          label="Status"
          value={params.get('status') ?? ''}
          onChange={(v) => set('status', v)}
          all="Any status"
          options={statuses}
        />
      )}

      {categories && categories.length > 0 && (
        <Picker
          label="Category"
          value={params.get('category') ?? ''}
          onChange={(v) => set('category', v)}
          all="Every category"
          options={categories.map((c) => ({ value: c, label: c }))}
        />
      )}

      <div className="ml-auto flex gap-2">
        <PrintButton />
        <Button variant="outline" asChild>
          <a href={`/api/reports/export?${exportQuery}&format=csv`}>
            <Download className="mr-2 h-4 w-4" /> CSV
          </a>
        </Button>
        <Button variant="outline" asChild>
          <a href={`/api/reports/export?${exportQuery}&format=xlsx`}>
            <Download className="mr-2 h-4 w-4" /> Excel
          </a>
        </Button>
      </div>
    </div>
  )
}

function PrintButton() {
  return (
    <Button variant="outline" onClick={() => window.print()}>
      <Printer className="mr-2 h-4 w-4" /> Print / PDF
    </Button>
  )
}

function Picker({
  label,
  value,
  onChange,
  all,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  all: string
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select
        className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
