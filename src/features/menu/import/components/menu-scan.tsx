'use client'

import * as React from 'react'
import { Camera, Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { SectionCard } from '@/features/dashboard/components/page-header'
import type { ImportRow } from '../schema'

/**
 * Photograph the printed menu and let it be read for you.
 *
 * The heaviest lifting of onboarding for the price of one photo. Nothing is
 * saved from here — the result lands in the review table so the owner corrects
 * a misread price before it reaches a guest's bill.
 */
export function MenuScan({
  configured,
  onRows,
}: {
  configured: boolean
  onRows: (rows: ImportRow[]) => void
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [scanning, setScanning] = React.useState(false)

  const scan = async (files: FileList) => {
    setScanning(true)
    try {
      const body = new FormData()
      Array.from(files)
        .slice(0, 4)
        .forEach((file) => body.append('file', file))

      const response = await fetch('/api/menu/scan', { method: 'POST', body })
      const data = (await response.json()) as { items?: ImportRow[]; error?: string }

      if (!response.ok || !data.items) {
        toast.error(data.error ?? 'Could not read that menu')
        return
      }
      if (data.items.length === 0) {
        toast.error('No dishes found. Try a straight-on photo with the text in focus.')
        return
      }

      onRows(data.items)
      toast.success(`Found ${data.items.length} dishes — check them below before saving`)
    } catch {
      toast.error('Scan failed — check your connection and try again')
    } finally {
      setScanning(false)
    }
  }

  return (
    <SectionCard
      title="Scan your printed menu"
      description="Photograph the menu card you already have. Every dish, description and price is read for you."
    >
      {configured ? (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            capture="environment"
            className="hidden"
            onChange={(event) => {
              const files = event.target.files
              if (files?.length) void scan(files)
              event.target.value = ''
            }}
          />
          <Button onClick={() => inputRef.current?.click()} loading={scanning}>
            {scanning ? <Loader2 className="animate-spin" /> : <Camera />}
            {scanning ? 'Reading your menu…' : 'Take or choose photos'}
          </Button>

          <p className="mt-3 flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Sparkles className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Up to 4 pages at once. Nothing is saved until you review it — anything misread is
              yours to fix first. Photos are read, not stored.
            </span>
          </p>
        </>
      ) : (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Not set up on this deployment</p>
          <p className="mt-1">
            Menu scanning needs an <code className="rounded bg-muted px-1">ANTHROPIC_API_KEY</code>{' '}
            environment variable, which bills per scan (a few cents per menu). Everything else on
            this page works without it — the spreadsheet import is the closest equivalent and is
            free.
          </p>
        </div>
      )}
    </SectionCard>
  )
}
