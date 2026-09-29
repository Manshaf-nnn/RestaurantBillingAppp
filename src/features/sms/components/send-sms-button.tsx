'use client'

import * as React from 'react'
import { MessageSquare } from 'lucide-react'
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
import { Textarea } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { sendManualSms } from '@/features/sms/actions'
import { countSegments } from '@/features/sms/encoding'
import { callAction } from '@/lib/use-action'

/**
 * "Send SMS" wherever a guest's record is on screen.
 *
 * One component for the order page, the bookings list, the delivery desk and
 * the customer page, so the words, the counter and the failure message are
 * the same everywhere. It shows the number only; the server reads the real
 * one off the record, so nothing typed here can redirect a message.
 */
export function SendSmsButton({
  entity,
  entityId,
  to,
  name,
  defaultText = '',
  variant = 'outline',
  size = 'default',
  iconOnly = false,
}: {
  entity: 'Order' | 'Reservation' | 'Customer'
  entityId: string
  /** For display. The server uses the record's own number. */
  to: string
  name?: string | null
  defaultText?: string
  variant?: React.ComponentProps<typeof Button>['variant']
  size?: React.ComponentProps<typeof Button>['size']
  iconOnly?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState(defaultText)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) setText(defaultText)
  }, [open, defaultText])

  const parts = React.useMemo(() => (text.trim() ? countSegments(text) : null), [text])

  const send = async () => {
    setBusy(true)
    const result = await callAction(() => sendManualSms({ entity, entityId, text }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`Sent to ${result.data.dialled ?? to}`)
    setOpen(false)
  }

  return (
    <>
      <Button
        variant={variant}
        size={iconOnly ? (size === 'sm' ? 'icon-sm' : 'icon') : size}
        onClick={() => setOpen(true)}
        aria-label={iconOnly ? 'Send SMS' : undefined}
      >
        <MessageSquare />
        {iconOnly ? null : 'Send SMS'}
      </Button>

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Text {name?.trim() || 'this guest'}</DialogTitle>
            <DialogDescription>To {to}. One message, from your sender name.</DialogDescription>
          </DialogHeader>

          <Field
            label="Message"
            required
            hint={
              parts
                ? `${text.length} characters · ${parts.segments} SMS part${parts.segments === 1 ? '' : 's'}${
                    parts.alphabet === 'UCS2' ? ' (unicode: 70 characters per part)' : ''
                  }`
                : 'Up to 480 characters.'
            }
          >
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </Field>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={send} loading={busy} disabled={!text.trim() || busy}>
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
