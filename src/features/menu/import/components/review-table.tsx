'use client'

import * as React from 'react'
import { Check, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { importMenuRows } from '../actions'
import type { ImportRow } from '../schema'
import { callAction } from '@/lib/use-action'

/**
 * The review step every import route lands in.
 *
 * Nothing reaches the menu without passing through here. A scanned price that
 * came out wrong, a spreadsheet column shifted by one — both are obvious in a
 * table and invisible in a success toast, and a wrong price on a live menu is
 * charged to a real guest.
 */
export function ReviewTable({
  rows,
  currency,
  onDone,
  onDiscard,
}: {
  rows: ImportRow[]
  currency: string
  onDone: () => void
  onDiscard: () => void
}) {
  const [draft, setDraft] = React.useState<ImportRow[]>(rows)
  const [saving, setSaving] = React.useState(false)
  const [overwrite, setOverwrite] = React.useState(false)

  React.useEffect(() => setDraft(rows), [rows])

  const update = (index: number, patch: Partial<ImportRow>) =>
    setDraft((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const remove = (index: number) =>
    setDraft((current) => current.filter((_, i) => i !== index))

  const missingPrice = draft.filter((row) => !row.price).length

  const save = async () => {
    if (!draft.length) return
    setSaving(true)
    const result = await callAction(() => importMenuRows({ rows: draft, overwriteExisting: overwrite }))
    setSaving(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    const { created, updated, categories } = result.data
    toast.success(
      `Added ${created} item${created === 1 ? '' : 's'}` +
        (updated ? `, updated ${updated}` : '') +
        (categories ? ` across ${categories} new categor${categories === 1 ? 'y' : 'ies'}` : ''),
    )
    onDone()
  }

  if (!draft.length) return null

  return (
    <SectionCard
      title={`Review ${draft.length} item${draft.length === 1 ? '' : 's'}`}
      description="Fix anything that came through wrong, then save. Nothing is on your menu until you do."
      actions={
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          Discard
        </Button>
      }
    >
      {missingPrice > 0 ? (
        <p className="mb-3 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
          <strong>{missingPrice}</strong> item{missingPrice === 1 ? ' has' : 's have'} no price yet —
          fill those in before saving.
        </p>
      ) : null}

      <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
        {draft.map((row, index) => (
          <div
            key={index}
            className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_7rem_auto] sm:items-center"
          >
            <Input
              value={row.categoryName}
              onChange={(event) => update(index, { categoryName: event.target.value })}
              placeholder="Category"
              aria-label={`Category for row ${index + 1}`}
            />
            <Input
              value={row.name}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder="Item name"
              aria-label={`Name for row ${index + 1}`}
            />
            <Input
              value={row.price === 0 ? '' : String(row.price)}
              onChange={(event) =>
                update(index, { price: Number(event.target.value.replace(/[^0-9.]/g, '')) || 0 })
              }
              placeholder={`${currency} 0`}
              inputMode="decimal"
              aria-label={`Price for row ${index + 1}`}
              className={row.price ? undefined : 'border-warning'}
            />
            <div className="flex items-center justify-between gap-3 sm:justify-end">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={row.isVeg}
                  onCheckedChange={(value) => update(index, { isVeg: value })}
                />
                Veg
              </label>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => remove(index)}
                aria-label={`Remove ${row.name || 'row'}`}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={overwrite} onCheckedChange={setOverwrite} />
          <span className="text-muted-foreground">
            Update items that already exist (otherwise they are skipped)
          </span>
        </label>
        <Button onClick={save} loading={saving} disabled={missingPrice > 0}>
          <Check /> Save {draft.length} item{draft.length === 1 ? '' : 's'} to my menu
        </Button>
      </div>
    </SectionCard>
  )
}
