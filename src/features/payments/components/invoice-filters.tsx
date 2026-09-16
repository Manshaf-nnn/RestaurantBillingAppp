'use client'

import { useRouter, useSearchParams } from 'next/navigation'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All invoices' },
  { value: 'OUTSTANDING', label: 'Outstanding' },
  { value: 'SETTLED', label: 'Settled' },
  { value: 'REFUNDED', label: 'Refunded' },
  { value: 'FAILED', label: 'Failed' },
] as const

const PER_PAGE_OPTIONS = ['50', '100', 'ALL'] as const

/**
 * Status and rows-per-page for the invoices list (abc.md §2).
 *
 * State lives in the URL, next to the period the report filters wrote, so
 * the server component narrows the query and the figures are the database's.
 * Changing a filter goes back to page 1.
 */
export function InvoiceFilters({ status, perPage }: { status: string; perPage: string }) {
  const router = useRouter()
  const params = useSearchParams()

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString())
    if (value && value !== 'ALL') next.set(key, value)
    else next.delete(key)
    next.delete('page')
    router.push(`?${next.toString()}`)
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Select value={status} onValueChange={(value) => set('status', value)}>
        <SelectTrigger className="w-44" aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={perPage} onValueChange={(value) => set('perPage', value === '50' ? '' : value)}>
        <SelectTrigger className="w-32" aria-label="Rows per page">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PER_PAGE_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {option === 'ALL' ? 'All rows' : `${option} rows`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
