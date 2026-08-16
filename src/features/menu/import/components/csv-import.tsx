'use client'

import * as React from 'react'
import { Download, FileSpreadsheet, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { SectionCard } from '@/features/dashboard/components/page-header'
import type { ImportRow } from '../schema'

const TEMPLATE_HEADERS = [
  'Category',
  'Item name',
  'Description',
  'Price',
  'Veg (yes/no)',
  'Spice (none/mild/medium/hot/extra_hot)',
  'Prep minutes',
] as const

const TEMPLATE_ROWS = [
  ['Starters', 'Garlic Bread', 'Wood-fired bread with garlic butter', '450', 'yes', 'none', '10'],
  ['Starters', 'Chicken Wings', 'Six wings, choice of sauce', '850', 'no', 'medium', '15'],
  ['Mains', 'Chicken Kottu', 'House speciality', '1200', 'no', 'hot', '20'],
]

/**
 * Parse a CSV, handling quoted fields.
 *
 * Written by hand rather than pulled in as a dependency: menu exports contain
 * commas inside descriptions and the occasional quoted field, which is the only
 * part of the format that actually needs care.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      // Swallow the \n of a \r\n pair.
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.some((value) => value.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += char
    }
  }

  row.push(field)
  if (row.some((value) => value.trim() !== '')) rows.push(row)
  return rows
}

const truthy = new Set(['yes', 'y', 'true', '1', 'veg', 'vegetarian'])

function toSpice(value: string): ImportRow['spiceLevel'] {
  const normalised = value.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return (['NONE', 'MILD', 'MEDIUM', 'HOT', 'EXTRA_HOT'] as const).includes(
    normalised as ImportRow['spiceLevel'],
  )
    ? (normalised as ImportRow['spiceLevel'])
    : 'NONE'
}

export function CsvImport({ onRows }: { onRows: (rows: ImportRow[]) => void }) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [error, setError] = React.useState<string | null>(null)

  const downloadTemplate = () => {
    const csv = [TEMPLATE_HEADERS, ...TEMPLATE_ROWS]
      .map((row) => row.map((cell) => (cell.includes(',') ? `"${cell}"` : cell)).join(','))
      .join('\n')

    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'menu-template.csv'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    setTimeout(() => URL.revokeObjectURL(url), 5_000)
  }

  const read = async (file: File) => {
    setError(null)
    try {
      const text = await file.text()
      const table = parseCsv(text)
      if (table.length < 2) {
        setError('That file has no rows under the heading line.')
        return
      }

      // Drop the header row only if it looks like one.
      const first = table[0].map((cell) => cell.trim().toLowerCase())
      const hasHeader = first.some((cell) => cell.includes('name') || cell.includes('category'))
      const body = hasHeader ? table.slice(1) : table

      const rows: ImportRow[] = []
      const problems: string[] = []

      body.forEach((cells, index) => {
        const lineNumber = index + (hasHeader ? 2 : 1)
        const [category, name, description, price, veg, spice, prep] = cells.map((cell) =>
          (cell ?? '').trim(),
        )

        if (!category || !name) {
          problems.push(`Line ${lineNumber}: needs both a category and an item name`)
          return
        }
        const parsedPrice = Number((price || '0').replace(/[^0-9.]/g, ''))
        if (!Number.isFinite(parsedPrice)) {
          problems.push(`Line ${lineNumber}: "${price}" is not a price`)
          return
        }

        rows.push({
          categoryName: category,
          name,
          description: description ?? '',
          price: parsedPrice,
          isVeg: truthy.has((veg ?? '').toLowerCase()),
          spiceLevel: toSpice(spice ?? ''),
          prepTimeMinutes: Number(prep) > 0 ? Math.min(180, Number(prep)) : 15,
          imageUrl: '',
        })
      })

      if (problems.length) {
        // Show the first few rather than a wall of text.
        setError(`${problems.slice(0, 4).join(' · ')}${problems.length > 4 ? ` · and ${problems.length - 4} more` : ''}`)
      }
      if (!rows.length) {
        toast.error('No usable rows in that file')
        return
      }

      onRows(rows)
      toast.success(`Read ${rows.length} item${rows.length === 1 ? '' : 's'} — check them below`)
    } catch {
      setError('Could not read that file. Save it as CSV and try again.')
    }
  }

  return (
    <SectionCard
      title="Import from a spreadsheet"
      description="Fill in the template in Excel or Google Sheets, then upload it. No running cost."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={downloadTemplate}>
          <Download /> Download template
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void read(file)
            event.target.value = ''
          }}
        />
        <Button onClick={() => inputRef.current?.click()}>
          <Upload /> Upload filled-in CSV
        </Button>
      </div>

      <p className="mt-3 flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Export as CSV from Excel or Google Sheets. Categories are created automatically from the
          Category column — you do not need to set them up first.
        </span>
      </p>

      {error ? <p className="mt-3 text-sm font-medium text-destructive">{error}</p> : null}
    </SectionCard>
  )
}
