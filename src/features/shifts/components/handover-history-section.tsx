'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import {
  HandoverDetailsDialog,
  HandoverHistoryTable,
} from '@/features/handover/components/shift-handover'
import { cancelShiftHandoverAction } from '@/features/handover/shift-actions'
import type { ShiftHandoverView } from '@/features/handover/shift-types'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'

/**
 * The handover history for the manager's page: the same table and the same
 * details dialog the Shift tab uses, so a manager reads exactly what the
 * staff member read — plus the full reconciliation, which the stored
 * snapshot always carries.
 */
export function HandoverHistorySection({
  rows,
  viewerId,
  canCancelOthers,
  currency,
  locale,
}: {
  rows: ShiftHandoverView[]
  viewerId: string
  canCancelOthers: boolean
  currency: string
  locale: string
}) {
  const router = useRouter()
  const [details, setDetails] = React.useState<ShiftHandoverView | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const money = (minor: number) => formatMoney(minor, currency, locale)

  const cancel = async (row: ShiftHandoverView) => {
    setBusy(row.id)
    const result = await callAction(() => cancelShiftHandoverAction({ handoverId: row.id }))
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Withdrawn.')
    router.refresh()
  }

  return (
    <div className="rounded-xl border bg-card p-4 shadow-soft">
      <HandoverHistoryTable
        rows={rows}
        viewerId={viewerId}
        mineId={null}
        canCancelOthers={canCancelOthers}
        busy={busy}
        money={money}
        onDetails={setDetails}
        onCancel={cancel}
      />
      <HandoverDetailsDialog row={details} onClose={() => setDetails(null)} currency={currency} locale={locale} />
    </div>
  )
}
