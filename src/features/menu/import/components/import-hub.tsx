'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Camera, FileSpreadsheet, HeartHandshake, ImagePlus, Pencil } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { cn } from '@/lib/utils'
import { BulkPhotos, type PhotoTarget } from './bulk-photos'
import { Concierge } from './concierge'
import { CsvImport } from './csv-import'
import { MenuScan } from './menu-scan'
import { ReviewTable } from './review-table'
import type { ImportRow } from '../schema'

type Method = 'scan' | 'csv' | 'photos' | 'concierge'

const METHODS: Array<{
  key: Method
  label: string
  blurb: string
  icon: typeof Camera
}> = [
  {
    key: 'scan',
    label: 'Scan a printed menu',
    blurb: 'Photograph the menu you already have',
    icon: Camera,
  },
  {
    key: 'csv',
    label: 'Spreadsheet',
    blurb: 'Fill in a template and upload it',
    icon: FileSpreadsheet,
  },
  {
    key: 'photos',
    label: 'Add photos in bulk',
    blurb: 'Drop in a folder of dish photos',
    icon: ImagePlus,
  },
  {
    key: 'concierge',
    label: 'Have us do it',
    blurb: 'Send it over and we will enter it',
    icon: HeartHandshake,
  },
]

/**
 * Four ways in, one review step.
 *
 * Restaurants arrive with menus in different shapes — printed card, existing
 * spreadsheet, handwritten sheet, nothing at all — so no single import route
 * fits everyone. Whichever they pick, the items land in the same review table
 * before saving, and the one-at-a-time form stays exactly where it was for
 * edits and additions afterwards.
 */
export function ImportHub({
  scanConfigured,
  currency,
  photoTargets,
  ownerName,
}: {
  scanConfigured: boolean
  currency: string
  photoTargets: PhotoTarget[]
  ownerName: string
}) {
  const router = useRouter()
  const [method, setMethod] = React.useState<Method>(scanConfigured ? 'scan' : 'csv')
  const [rows, setRows] = React.useState<ImportRow[] | null>(null)

  const receive = (next: ImportRow[]) => {
    setRows(next)
    // Bring the review table into view — on a phone it lands below the fold.
    window.setTimeout(() => {
      document.getElementById('import-review')?.scrollIntoView({ behavior: 'smooth' })
    }, 100)
  }

  return (
    <>
      <PageHeader
        title="Add your menu"
        description="Pick whichever way suits the menu you have. You can mix them, and change anything afterwards."
        actions={
          <Button variant="outline" asChild>
            <Link href="/dashboard/menu">
              <Pencil /> Add items one by one
            </Link>
          </Button>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {METHODS.map((entry) => {
          const Icon = entry.icon
          const active = method === entry.key
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setMethod(entry.key)}
              className={cn(
                'flex min-w-0 items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-soft transition-colors',
                active ? 'border-primary ring-2 ring-primary/20' : 'hover:bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg',
                  active ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{entry.label}</span>
                <span className="block text-xs text-muted-foreground">{entry.blurb}</span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="space-y-5">
        {method === 'scan' ? <MenuScan configured={scanConfigured} onRows={receive} /> : null}
        {method === 'csv' ? <CsvImport onRows={receive} /> : null}
        {method === 'photos' ? <BulkPhotos targets={photoTargets} /> : null}
        {method === 'concierge' ? <Concierge defaultName={ownerName} /> : null}

        {rows ? (
          <div id="import-review">
            <ReviewTable
              rows={rows}
              currency={currency}
              onDiscard={() => setRows(null)}
              onDone={() => {
                setRows(null)
                router.refresh()
              }}
            />
          </div>
        ) : null}
      </div>
    </>
  )
}
