'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Timer, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { LocalDateTime } from '@/components/local-time'
import { UNIT_LABELS } from '@/features/inventory/units'
import { newRequestKey } from '@/lib/request-key'
import { useAction } from '@/lib/use-action'
import { cancelBatchAction, completeBatchAction } from '../actions'
import type { StockUnit } from '@prisma/client'

export interface OpenBatchRow {
  id: string
  number: string
  name: string
  plannedQty: number
  unit: StockUnit | null
  branchName: string | null
  startedAt: string
}

/**
 * Batches started and not yet finished (correctionA.md §10).
 *
 * ── Why the shortfall has to be named ─────────────────────────────────────
 *
 * The reason is the only part of this an owner cannot reconstruct later. That
 * a batch planned 900g and made 850 is on the row; WHY is a thing one person
 * knew for about an hour. "Stuck to the bowl" and "the mix was off" are the
 * difference between a yield to design around and a supplier to talk to, and
 * a column of unexplained shortfalls is a column nobody reads twice.
 *
 * It is asked for only when the figures actually differ, for the same reason
 * the drawer stopped demanding prose about a two-rupee gap: a question that
 * fires when there is nothing to answer teaches people to dismiss it.
 */
export function OpenBatches({
  batches,
  canManage,
}: {
  batches: OpenBatchRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const { busy, run } = useAction()
  const [actual, setActual] = React.useState<Record<string, string>>({})
  const [reason, setReason] = React.useState<Record<string, string>>({})
  const keys = React.useRef<Record<string, string>>({})

  if (batches.length === 0) return null

  /** One key per batch per attempt, so a double tap finishes it once. */
  const keyFor = (id: string) => (keys.current[id] ??= newRequestKey())

  const finish = (batch: OpenBatchRow) => {
    const value = Number(actual[batch.id])
    if (!Number.isFinite(value) || value < 0) return
    void run(
      () =>
        completeBatchAction({
          batchId: batch.id,
          clientRequestId: keyFor(batch.id),
          actualQuantity: value,
          varianceNote: reason[batch.id] || undefined,
        }),
      {
        onDone: () => {
          delete keys.current[batch.id]
          router.refresh()
        },
      },
    )
  }

  return (
    <SectionCard
      title="Batches in progress"
      description="Started but not finished. Nothing has left stock yet — that happens when you mark one done."
    >
      <ul className="divide-y">
        {batches.map((batch) => {
          const unit = batch.unit ? UNIT_LABELS[batch.unit] : ''
          const typed = actual[batch.id] ?? ''
          const value = Number(typed)
          const valid = typed.trim() !== '' && Number.isFinite(value) && value >= 0
          const variance = valid ? value - batch.plannedQty : null
          // Asked for only when there is something to explain.
          const needsReason = variance !== null && variance !== 0

          return (
            <li key={batch.id} className="py-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant="warning">
                  <Timer /> in progress
                </Badge>
                <span className="font-medium">{batch.name}</span>
                <span className="text-sm text-muted-foreground">
                  aiming for {batch.plannedQty} {unit}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {batch.number}
                  {batch.branchName ? ` · ${batch.branchName}` : ''} ·{' '}
                  <LocalDateTime value={batch.startedAt} />
                </span>
              </div>

              {canManage ? (
                <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
                  <div className="space-y-1">
                    <Label className="text-xs">Actually produced ({unit})</Label>
                    <Input
                      inputMode="decimal"
                      placeholder="0"
                      value={typed}
                      onChange={(e) =>
                        setActual((c) => ({ ...c, [batch.id]: e.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">
                      {needsReason ? (
                        <>
                          {variance! > 0 ? 'Over' : 'Short'} by {Math.abs(variance!)} {unit} — why?
                        </>
                      ) : (
                        'Note (optional)'
                      )}
                    </Label>
                    <Input
                      placeholder={
                        needsReason ? 'e.g. stuck to the bowl' : 'Anything worth recording'
                      }
                      value={reason[batch.id] ?? ''}
                      onChange={(e) => setReason((c) => ({ ...c, [batch.id]: e.target.value }))}
                    />
                  </div>

                  <div className="flex gap-1">
                    <Button disabled={busy || !valid} onClick={() => finish(batch)}>
                      Mark done
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Cancel batch ${batch.number}`}
                      disabled={busy}
                      onClick={() =>
                        void run(() => cancelBatchAction({ batchId: batch.id }), {
                          onDone: () => router.refresh(),
                        })
                      }
                    >
                      <X />
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </SectionCard>
  )
}
