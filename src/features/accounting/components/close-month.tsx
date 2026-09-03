'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
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
import { Input } from '@/components/ui/input'
import { callAction } from '@/lib/use-action'
import { closeMonthAction, reopenPeriodAction } from '../actions'

/**
 * Close Month (acCal.md §13). When the checklist is not fully clear the
 * button still works — an accountant sometimes must close — but it demands
 * the word CLOSE and a written reason, and both go on the record.
 */
export function CloseMonthButton({
  month,
  monthLabel,
  readyPercent,
  outstanding,
  closedPeriodId,
}: {
  month: string
  monthLabel: string
  readyPercent: number
  outstanding: string[]
  closedPeriodId: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [notes, setNotes] = React.useState('')
  const [override, setOverride] = React.useState('')
  const [pending, setPending] = React.useState(false)

  const clear = outstanding.length === 0

  const close = async () => {
    setPending(true)
    const result = await callAction(() =>
      closeMonthAction({ month, notes: notes.trim(), override: override.trim() }),
    )
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${monthLabel} is closed.`)
    setOpen(false)
    router.refresh()
  }

  const reopen = async () => {
    if (!closedPeriodId) return
    setPending(true)
    const result = await callAction(() => reopenPeriodAction({ periodId: closedPeriodId }))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Reopened. Changes are on your name now.')
    router.refresh()
  }

  if (closedPeriodId) {
    return (
      <Button variant="outline" loading={pending} onClick={reopen}>
        Reopen {monthLabel}
      </Button>
    )
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Close {monthLabel}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close {monthLabel}?</DialogTitle>
            <DialogDescription>
              {clear
                ? 'Every check is clear. Once closed, the orders and payments inside this month cannot be changed — corrections are made with new, dated entries.'
                : `${readyPercent}% ready. These are not clear yet: ${outstanding.join('; ')}.`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">
                {clear ? 'Note (optional)' : 'Why are you closing anyway? (required)'}
              </span>
              <Input value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={300} />
            </label>
            {!clear ? (
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Type CLOSE to confirm</span>
                <Input value={override} onChange={(event) => setOverride(event.target.value)} placeholder="CLOSE" />
              </label>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Not yet
            </Button>
            <Button
              loading={pending}
              disabled={!clear && (override.trim() !== 'CLOSE' || notes.trim().length === 0)}
              onClick={close}
            >
              Close the month
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
