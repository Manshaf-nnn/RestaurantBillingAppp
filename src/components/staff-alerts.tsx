'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Check } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LocalDateTime } from '@/components/local-time'
import { useSocketEvent } from '@/hooks/use-socket'
import { EVENTS, type NotificationPayload, type ServiceRequestPayload } from '@/lib/realtime/events'
import { callAction } from '@/lib/use-action'
import {
  acknowledgeServiceRequestAction,
  resolveServiceRequest,
} from '@/features/orders/actions'

/**
 * The one listener every staff screen has (pro.A.md §14, §15, §17).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A waiter call raised a popup on exactly one screen: `/waiter`. A cashier
 * standing at the till, a manager on the dashboard and a kitchen screen all
 * received the same socket event and did nothing with it — the event was
 * delivered and thrown away, so the only way anybody else learned about it was
 * to navigate somewhere that happened to re-render. The spec's own example
 * ("cashier is on POS → waiter calls → popup appears") could not happen.
 *
 * So the listening moves here, into the shells both families of staff screens
 * already mount. One component, one subscription, one popup, wherever the
 * person is standing.
 *
 * ── Why it filters on the branch ────────────────────────────────────────────
 *
 * Rooms are keyed `r:<restaurantId>:<role>` with no branch segment, so every
 * site in the chain receives every event. The stored notification list IS
 * branch-filtered, so without the same filter here a live toast says something
 * the bell will never show. `null` on either side means business-wide, which
 * everybody sees.
 */

const REQUEST_LABEL: Record<ServiceRequestPayload['type'], string> = {
  WATER: 'Water',
  PLATES: 'Extra plates',
  BILL: 'The bill',
  HELP: 'Needs help',
  CLEAN_TABLE: 'Clean the table',
  CALL_WAITER: 'Calling a waiter',
}

export function StaffAlerts({
  branchIds,
  canAnswerCalls,
  branchName,
}: {
  /** The locations this viewer may see. `null` means every one of them. */
  branchIds: string[] | null
  /** Whether this person may acknowledge or resolve a table's call. */
  canAnswerCalls: boolean
  branchName?: string | null
}) {
  const router = useRouter()
  const [call, setCall] = React.useState<ServiceRequestPayload | null>(null)
  const [busy, setBusy] = React.useState(false)

  /*
   * Mine when I see every location, when the event names none (a genuine
   * business-wide notice), or when it happened somewhere I can see. The same
   * shape the order boards already use.
   */
  const isOurs = React.useCallback(
    (eventBranchId: string | null | undefined) =>
      branchIds === null || !eventBranchId || branchIds.includes(eventBranchId),
    [branchIds],
  )

  useSocketEvent(EVENTS.NOTIFICATION, (payload: NotificationPayload) => {
    if (!isOurs(payload.branchId)) return
    // A service request raises its own dialog below; a toast as well would be
    // the same news twice.
    if (payload.type === 'SERVICE_REQUEST') return
    toast(payload.title, { description: payload.body ?? undefined })
    router.refresh()
  })

  useSocketEvent(EVENTS.SERVICE_REQUEST_CREATED, (payload: ServiceRequestPayload) => {
    if (!isOurs(payload.branchId)) return
    setCall(payload)
  })

  // Somebody else went, or it is already dealt with: stop asking.
  useSocketEvent(EVENTS.SERVICE_REQUEST_ACKNOWLEDGED, (payload: { id: string }) => {
    setCall((current) => (current?.id === payload.id ? null : current))
  })
  useSocketEvent(EVENTS.SERVICE_REQUEST_RESOLVED, (payload: { id: string }) => {
    setCall((current) => (current?.id === payload.id ? null : current))
  })

  const answer = async (kind: 'acknowledge' | 'resolve') => {
    if (!call) return
    setBusy(true)
    const result = await callAction(() =>
      kind === 'acknowledge'
        ? acknowledgeServiceRequestAction({ requestId: call.id })
        : resolveServiceRequest(call.id),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(kind === 'acknowledge' ? 'On your way.' : 'Marked done.')
    setCall(null)
    router.refresh()
  }

  return (
    <Dialog open={call !== null} onOpenChange={(open) => { if (!open) setCall(null) }}>
      <DialogContent size="sm" data-testid="staff-call-popup">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-2xl">
            <Bell className="size-6 text-warning" />
            Table {call?.tableNumber}
          </DialogTitle>
          <DialogDescription className="text-base">
            {call ? REQUEST_LABEL[call.type] : ''}
            {branchName ? ` · ${branchName}` : ''}
            {call ? <> · <LocalDateTime value={call.createdAt} /></> : null}
            {call?.requestedByName && call.requestedByName !== `Table ${call.tableNumber}`
              ? ` · called by ${call.requestedByName}`
              : ''}
            {call?.note ? ` · ${call.note}` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setCall(null)}>
            {canAnswerCalls ? 'Someone else will' : 'Close'}
          </Button>
          {canAnswerCalls ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => answer('resolve')}>
                Already done
              </Button>
              <Button variant="warning" loading={busy} onClick={() => answer('acknowledge')}>
                <Check /> On my way
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
