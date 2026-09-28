'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { Download, FileSpreadsheet, FileText, Phone } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/primitives'
import { callAction } from '@/lib/use-action'
import { countCustomerNumbersAction } from '@/features/customers/export-actions'

/**
 * "Export numbers": the customers' phone numbers as TXT, CSV or Excel.
 *
 * The category is chosen here, on top of whatever the page is already
 * filtered by — search, visits, spend, kind, branch all travel with the
 * download, the way every ExportMenu forwards its page's filters. A live
 * count says what the file will hold before it is downloaded. The downloads
 * themselves are plain links to the export endpoint, which re-checks the
 * permission and audits how many numbers left.
 */
export function CustomerExportDialog({
  categories,
}: {
  categories: Array<{ id: string; name: string }>
}) {
  const params = useSearchParams()
  const [open, setOpen] = React.useState(false)
  const [category, setCategory] = React.useState(params.get('category') ?? '')
  const [mobileOnly, setMobileOnly] = React.useState(true)
  const [count, setCount] = React.useState<null | { count: number; skipped: { invalid: number; blocked: number; landline: number; duplicate: number }; truncated: boolean }>(null)
  const [counting, setCounting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // The page's own filters, as the endpoint and the count both read them.
  const segment = React.useMemo(() => {
    const one = (key: string) => params.get(key)?.trim() ?? ''
    const num = (key: string) => (one(key) && Number.isFinite(Number(one(key))) ? Number(one(key)) : undefined)
    return {
      ...(one('q') ? { q: one('q') } : {}),
      ...(num('minVisits') !== undefined ? { minVisits: num('minVisits') } : {}),
      ...(num('minSpent') !== undefined ? { minSpent: num('minSpent')! * 100 } : {}),
      ...(num('notSeenForDays') !== undefined ? { notSeenForDays: num('notSeenForDays') } : {}),
      ...(num('minPoints') !== undefined ? { minPoints: num('minPoints') } : {}),
      ...(one('kind') ? { kind: one('kind') as 'new' | 'returning' | 'repeat' | 'regular' | 'lapsed' } : {}),
    }
  }, [params])

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setCounting(true)
    setError(null)
    void (async () => {
      const result = await callAction(() =>
        countCustomerNumbersAction({ segment, category, mobileOnly, branchId: params.get('branch') ?? '' }),
      )
      if (cancelled) return
      setCounting(false)
      if (!result.ok) {
        setError(result.error)
        setCount(null)
        return
      }
      setCount(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [open, segment, category, mobileOnly, params])

  const href = (format: 'txt' | 'csv' | 'xlsx') => {
    const next = new URLSearchParams(params.toString())
    next.delete('page')
    next.set('type', 'customer-numbers')
    next.set('format', format)
    if (category) next.set('category', category)
    else next.delete('category')
    next.set('mobile', mobileOnly ? '1' : '0')
    return `/api/reports/export?${next.toString()}`
  }

  const selectClass =
    'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const nothing = !count || count.count === 0

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Download /> Export numbers
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export customer numbers</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Numbers of the customers on this screen, filtered as it is now. Choose a category to
              narrow further. Blocked customers and numbers that cannot be dialled are left out.
            </p>

            <Field label="Category" htmlFor="export-category">
              <select
                id="export-category"
                className={selectClass}
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">All categories</option>
                {categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
                <option value="none">No category</option>
              </select>
            </Field>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={mobileOnly} onCheckedChange={(value) => setMobileOnly(value === true)} />
              Mobile numbers only (07…) — leave out landlines
            </label>

            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              {error ? (
                <span className="text-destructive">{error}</span>
              ) : counting || !count ? (
                <span className="text-muted-foreground">Counting…</span>
              ) : (
                <>
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <Phone className="size-4" /> {count.count.toLocaleString()} number{count.count === 1 ? '' : 's'}
                  </span>
                  {count.skipped.invalid + count.skipped.blocked + count.skipped.landline + count.skipped.duplicate > 0 ? (
                    <span className="block text-xs text-muted-foreground">
                      Left out:{' '}
                      {[
                        count.skipped.landline ? `${count.skipped.landline} landline` : null,
                        count.skipped.invalid ? `${count.skipped.invalid} not dialable` : null,
                        count.skipped.blocked ? `${count.skipped.blocked} blocked` : null,
                        count.skipped.duplicate ? `${count.skipped.duplicate} duplicate` : null,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </span>
                  ) : null}
                  {count.truncated ? (
                    <span className="block text-xs text-warning">Only the first 10,000 are included. Narrow the filters to get the rest.</span>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <DialogFooter className="flex-wrap gap-2 sm:justify-start">
            <Button asChild disabled={nothing}>
              <a href={href('txt')} download aria-disabled={nothing} onClick={(e) => nothing && e.preventDefault()}>
                <FileText /> TXT
              </a>
            </Button>
            <Button variant="outline" asChild disabled={nothing}>
              <a href={href('csv')} download aria-disabled={nothing} onClick={(e) => nothing && e.preventDefault()}>
                <FileText /> CSV
              </a>
            </Button>
            <Button variant="outline" asChild disabled={nothing}>
              <a href={href('xlsx')} download aria-disabled={nothing} onClick={(e) => nothing && e.preventDefault()}>
                <FileSpreadsheet /> Excel
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
