'use client'

import * as React from 'react'
import type { ProductionVarianceReason, StockUnit } from '@prisma/client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { UNIT_LABELS } from '@/features/inventory/units'
import { newRequestKey } from '@/lib/request-key'
import { useAction } from '@/lib/use-action'
import { cancelBatchAction, completeBatchAction } from '../actions'
import type { ProduceItemResult } from '../types'

/**
 * Mark a batch done (recorrection.md §3).
 *
 * The one place the actual quantity is entered — inline on the Create
 * confirmation ("made it already?") and in the prepared item's detail
 * ("enter actual qty → mark done"). One component so the rule is the same in
 * both: the moment the stock moves, the figure that moves it was typed by
 * somebody who measured it.
 *
 * ── Why the shortfall has to be named ─────────────────────────────────────
 *
 * The reason is the only part of this an owner cannot reconstruct later. That
 * a batch planned 900 g and made 850 is on the row; WHY is a thing one person
 * knew for about an hour. "Stuck to the bowl" and "the mix was off" are the
 * difference between a yield to design around and a supplier to talk to, and
 * a column of unexplained shortfalls is a column nobody reads twice.
 *
 * So when the figures differ, a reason from the ledger's own vocabulary AND
 * a note are required — the first cut asked for neither (the enum was never
 * sent, and the note was optional), which is how a variance column ends up
 * empty. When they match, nothing is asked: a question that fires when there
 * is nothing to answer teaches people to dismiss it.
 */

export const VARIANCE_REASONS: Array<{ value: ProductionVarianceReason; label: string }> = [
  { value: 'PRODUCTION_LOSS', label: 'Lost in production — reduced, stuck, spilled' },
  { value: 'INGREDIENT_SHORTAGE', label: 'Ran short of an ingredient' },
  { value: 'QUALITY_ISSUE', label: 'Quality — part of it was discarded' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'OTHER', label: 'Something else' },
]

const SELECT = 'h-10 w-full rounded-lg border border-input bg-background px-2 text-sm'

export function MarkDoneForm({
  batch,
  onDone,
  onCancelled,
  compact = false,
}: {
  batch: { id: string; number: string; plannedQty: number; unit: StockUnit | null }
  onDone: (result: ProduceItemResult) => void
  /** When given, offers to abandon the batch. Nothing to reverse: nothing moved. */
  onCancelled?: () => void
  compact?: boolean
}) {
  const { busy, run } = useAction()
  const [actual, setActual] = React.useState('')
  const [reason, setReason] = React.useState<ProductionVarianceReason | ''>('')
  const [note, setNote] = React.useState('')
  // One key per batch per attempt, so a double tap finishes it once.
  const key = React.useRef(newRequestKey('done'))

  const unit = batch.unit ? UNIT_LABELS[batch.unit] : ''
  const value = Number(actual)
  const valid = actual.trim() !== '' && Number.isFinite(value) && value >= 0
  const variance = valid ? value - batch.plannedQty : null
  const needsReason = variance !== null && variance !== 0
  const ready = valid && (!needsReason || (reason !== '' && note.trim().length > 0))

  const finish = () =>
    void run(
      () =>
        completeBatchAction({
          batchId: batch.id,
          clientRequestId: key.current,
          actualQuantity: value,
          varianceReason: needsReason && reason ? reason : undefined,
          varianceNote: note.trim() || undefined,
        }),
      {
        onDone: (result) => {
          key.current = newRequestKey('done')
          onDone(result)
        },
      },
    )

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="grid gap-2 sm:grid-cols-[11rem_1fr] sm:items-end">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`actual-${batch.id}`}>
            Actually produced ({unit})
          </Label>
          <Input
            id={`actual-${batch.id}`}
            inputMode="decimal"
            placeholder={String(batch.plannedQty)}
            value={actual}
            onChange={(event) => setActual(event.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground sm:pb-2.5">
          Aiming for {batch.plannedQty} {unit}.
          {variance !== null && variance !== 0
            ? ` ${variance > 0 ? 'Over' : 'Short'} by ${Math.abs(Math.round(variance * 1000) / 1000)} ${unit}.`
            : variance === 0
              ? ' Exactly as planned.'
              : ''}
        </p>
      </div>

      {needsReason ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`reason-${batch.id}`}>Why?</Label>
            <select
              id={`reason-${batch.id}`}
              className={SELECT}
              value={reason}
              onChange={(event) => setReason(event.target.value as ProductionVarianceReason | '')}
            >
              <option value="">Choose a reason…</option>
              {VARIANCE_REASONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`note-${batch.id}`}>In your words</Label>
            <Input
              id={`note-${batch.id}`}
              placeholder="e.g. stuck to the bowl"
              value={note}
              maxLength={300}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>
      ) : (
        <Input
          placeholder="Note (optional)"
          value={note}
          maxLength={300}
          onChange={(event) => setNote(event.target.value)}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !ready} loading={busy} onClick={finish}>
          Mark done
        </Button>
        {onCancelled ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(() => cancelBatchAction({ batchId: batch.id }), { onDone: onCancelled })
            }
          >
            Abandon batch
          </Button>
        ) : null}
      </div>
    </div>
  )
}
