'use client'

import * as React from 'react'
import type { ProductionVarianceReason, StockUnit } from '@prisma/client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { UNIT_LABELS, formatQuantity } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { newRequestKey } from '@/lib/request-key'
import { useAction } from '@/lib/use-action'
import { cancelBatchAction, completeBatchAction } from '../actions'
import type { ProduceItemResult } from '../types'

/**
 * Complete Production — the fifth screen (pro.b.md §6, §7).
 *
 * Actual produced quantity and its unit, the wastage, remarks — and beside
 * them the three figures the spec names: total ingredient cost (FIFO), actual
 * output, and actual cost per unit, which is the first divided by the second.
 * The cost per unit is computed from what was actually issued, never from the
 * plan, and never from the planned quantity when the output differed.
 *
 * ── Why the shortfall has to be named ─────────────────────────────────────
 *
 * The reason is the only part of this an owner cannot reconstruct later. That
 * a batch planned 10 kg and made 9.6 is on the row; WHY is a thing one person
 * knew for about an hour. So when the figures differ, a reason from the
 * ledger's own vocabulary AND a note are required. When they match, nothing
 * is asked: a question that fires when there is nothing to answer teaches
 * people to dismiss it.
 *
 * The wastage box pre-fills with the shortfall and stays editable: it explains
 * the gap, it never moves stock — there was no finished stock to waste — and
 * its cost is carried by what did come out.
 */

export const VARIANCE_REASONS: Array<{ value: ProductionVarianceReason; label: string }> = [
  { value: 'PRODUCTION_LOSS', label: 'Lost in production — reduced, stuck, spilled' },
  { value: 'INGREDIENT_SHORTAGE', label: 'Ran short of an ingredient' },
  { value: 'QUALITY_ISSUE', label: 'Quality — part of it was discarded' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'OTHER', label: 'Something else' },
]

const SELECT = 'h-10 w-full rounded-lg border border-input bg-background px-2 text-sm'

export function CompleteProductionForm({
  batch,
  units,
  /** What the ingredients cost — issued for real, or the plan's FIFO estimate. */
  ingredientCost,
  ingredientCostIsEstimate,
  currency,
  locale,
  onDone,
  onCancelled,
  onBack,
}: {
  batch: { id: string; number: string; plannedQty: number; unit: StockUnit | null }
  units?: StockUnit[]
  ingredientCost: number
  ingredientCostIsEstimate: boolean
  currency: string
  locale: string
  onDone: (result: ProduceItemResult) => void
  /** Only before issue — nothing to reverse then. Absent once issued. */
  onCancelled?: () => void
  onBack?: () => void
}) {
  const { busy, run } = useAction()
  const [actual, setActual] = React.useState('')
  const [actualUnit, setActualUnit] = React.useState<StockUnit | ''>(batch.unit ?? '')
  /** What the cook typed for wastage; until they do, the shortfall stands in. */
  const [wastageTyped, setWastageTyped] = React.useState<string | null>(null)
  const [reason, setReason] = React.useState<ProductionVarianceReason | ''>('')
  const [note, setNote] = React.useState('')
  // One key per batch per attempt, so a double tap finishes it once.
  const key = React.useRef(newRequestKey('done'))

  const choices = units && units.length > 0 ? units : batch.unit ? [batch.unit] : []
  const unitLabel = actualUnit ? UNIT_LABELS[actualUnit] : batch.unit ? UNIT_LABELS[batch.unit] : ''
  const value = Number(actual)
  const valid = actual.trim() !== '' && Number.isFinite(value) && value >= 0
  /*
   * The shortfall is only meaningful while the cook is answering in the unit
   * the batch was planned in; measured in another, the transaction converts
   * and this form cannot see the difference.
   */
  const sameUnit = actualUnit === '' || actualUnit === batch.unit
  const variance = valid && sameUnit ? value - batch.plannedQty : null
  const needsReason = variance !== null && variance !== 0
  const ready = valid && (!needsReason || (reason !== '' && note.trim().length > 0))

  // Wastage pre-fills with the shortfall until the cook types their own
  // figure — derived, not synced, so it is right on the same render.
  const shortfall = variance !== null && variance < 0 ? String(Math.round(-variance * 1000) / 1000) : ''
  const wastage = wastageTyped ?? shortfall
  React.useEffect(() => {
    if (needsReason && reason === '' && Number(wastage) > 0) setReason('PRODUCTION_LOSS')
  }, [needsReason, reason, wastage])

  const factor = minorUnitFactor(currency)
  const money = (minor: number) => formatMoney(Math.round(minor), currency, locale)
  const perUnit = (minor: number) => {
    const major = minor / factor
    const digits = major !== 0 && Math.abs(major) < 1 ? 4 : 2
    return `${formatMoney(0, currency, locale).replace(/[\d.,\s]/g, '')}${major.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  }
  // The spec's arithmetic, live: actual ingredient cost ÷ actual output.
  const actualCostPerUnit = valid && value > 0 && sameUnit ? ingredientCost / value : null

  const finish = () =>
    void run(
      () =>
        completeBatchAction({
          batchId: batch.id,
          clientRequestId: key.current,
          actualQuantity: value,
          actualUnit: actualUnit || undefined,
          varianceReason: needsReason && reason ? reason : undefined,
          varianceNote: note.trim() || undefined,
          wastageQuantity: wastage.trim() !== '' && Number(wastage) >= 0 ? Number(wastage) : undefined,
          notes: note.trim() || undefined,
        }),
      {
        onDone: (result) => {
          key.current = newRequestKey('done')
          onDone(result)
        },
      },
    )

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_7rem] sm:items-end">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`actual-${batch.id}`}>Actual Produced Quantity</Label>
            <Input
              id={`actual-${batch.id}`}
              inputMode="decimal"
              placeholder={String(batch.plannedQty)}
              value={actual}
              onChange={(event) => setActual(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`actual-unit-${batch.id}`}>Unit</Label>
            <select
              id={`actual-unit-${batch.id}`}
              className={SELECT}
              value={actualUnit}
              onChange={(event) => setActualUnit(event.target.value as StockUnit | '')}
              disabled={choices.length <= 1}
            >
              {choices.length === 0 ? <option value="">—</option> : null}
              {choices.map((option) => (
                <option key={option} value={option}>{UNIT_LABELS[option]}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Planned {batch.plannedQty} {batch.unit ? UNIT_LABELS[batch.unit] : ''}.
          {variance !== null && variance !== 0
            ? ` ${variance > 0 ? 'Over' : 'Short'} by ${Math.abs(Math.round(variance * 1000) / 1000)} ${unitLabel}.`
            : variance === 0
              ? ' Exactly as planned.'
              : ''}
        </p>

        <div className="grid gap-2 sm:grid-cols-[1fr_7rem] sm:items-end">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`wastage-${batch.id}`}>Wastage Quantity</Label>
            <Input
              id={`wastage-${batch.id}`}
              inputMode="decimal"
              placeholder="0"
              value={wastage}
              onChange={(event) => setWastageTyped(event.target.value)}
            />
          </div>
          <div className="self-end pb-2.5 text-xs text-muted-foreground">{unitLabel}</div>
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
              <Label className="text-xs" htmlFor={`note-${batch.id}`}>Remarks</Label>
              <Input
                id={`note-${batch.id}`}
                placeholder="e.g. slight trimming loss"
                value={note}
                maxLength={300}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`note-${batch.id}`}>Remarks</Label>
            <Input
              id={`note-${batch.id}`}
              placeholder="Optional"
              value={note}
              maxLength={300}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {onBack ? <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button> : null}
          <Button disabled={busy || !ready} loading={busy} onClick={finish}>
            Complete Production
          </Button>
          {onCancelled ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(() => cancelBatchAction({ batchId: batch.id }), { onDone: onCancelled })
              }
            >
              Abandon order
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Total Ingredient Cost (FIFO)</span>
          <span className="tabular-nums">{money(ingredientCost)}</span>
        </div>
        {ingredientCostIsEstimate ? (
          <p className="text-xs text-muted-foreground">Estimated — the ingredients are issued at completion, from the real lots.</p>
        ) : null}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Actual Output Quantity</span>
          <span className="tabular-nums">{valid ? formatQuantity(value, (actualUnit || batch.unit || 'PIECE') as StockUnit) : '—'}</span>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-2 font-semibold">
          <span>Actual Cost per {unitLabel || 'unit'}</span>
          <span className="tabular-nums">{actualCostPerUnit !== null ? perUnit(actualCostPerUnit) : '—'}</span>
        </div>
      </div>
    </div>
  )
}
