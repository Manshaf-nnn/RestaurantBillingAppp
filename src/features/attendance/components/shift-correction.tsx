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
import { Field } from '@/components/ui/label'
import { callAction } from '@/lib/use-action'
import { correctShift } from '../actions'

/**
 * Fix a shift whose times are wrong.
 *
 * The commonest two cases are a person who worked a morning and forgot to sign
 * in at all, and a sign-in from home that opened a shift nobody worked. Both
 * need a manager and a reason; neither should be possible to do silently, which
 * is why the original times stay on screen underneath while you edit.
 */
export function ShiftCorrection({
  shiftId,
  startedAt,
  endedAt,
  personName,
}: {
  shiftId: string
  startedAt: string
  endedAt: string | null
  personName: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [reason, setReason] = React.useState('')

  /** A `datetime-local` wants the viewer's own wall clock, not an ISO string. */
  const local = (iso: string | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  React.useEffect(() => {
    if (!open) return
    setFrom(local(startedAt))
    setTo(local(endedAt))
    setReason('')
  }, [open, startedAt, endedAt])

  const save = async () => {
    setSaving(true)
    const result = await callAction(() =>
      correctShift({
        shiftId,
        startedAt: from ? new Date(from).toISOString() : '',
        endedAt: to ? new Date(to).toISOString() : '',
        reason,
      }),
    )
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Corrected. The original times are kept.')
    setOpen(false)
    router.refresh()
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="underline underline-offset-2 hover:text-foreground"
      >
        correct
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct {personName}’s shift</DialogTitle>
            <DialogDescription>
              What the system recorded is kept exactly as it is. This is what the
              timesheet will use instead.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Started">
              <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Ended">
              <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
              <p className="mt-1 text-xs text-muted-foreground">
                Leave blank if they are still working.
              </p>
            </Field>
            <Field label="Why" required className="sm:col-span-2">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Worked the morning but forgot to sign in"
              />
            </Field>
          </div>

          <p className="text-xs text-muted-foreground">
            Recorded: {new Date(startedAt).toLocaleString()} →{' '}
            {endedAt ? new Date(endedAt).toLocaleString() : 'still open'}
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving} disabled={reason.trim().length < 3}>
              Save correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
