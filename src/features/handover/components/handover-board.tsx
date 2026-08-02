'use client'

import * as React from 'react'
import { Check, Send } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Textarea } from '@/components/ui/input'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { addShiftNote, resolveShiftNote } from '../actions'
import type { ShiftNoteView } from '../queries'

export function HandoverBoard({ initial }: { initial: ShiftNoteView[] }) {
  const [notes, setNotes] = React.useState(initial)
  const [body, setBody] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [resolving, setResolving] = React.useState<string | null>(null)

  React.useEffect(() => setNotes(initial), [initial])

  const add = async () => {
    if (!body.trim()) return
    setBusy(true)
    const result = await addShiftNote({ body })
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setNotes((current) => [
      { id: result.data.id, body: body.trim(), authorName: 'You', createdAt: new Date().toISOString() },
      ...current,
    ])
    setBody('')
    toast.success('Note left for the next shift')
  }

  const done = async (id: string) => {
    setResolving(id)
    const result = await resolveShiftNote(id)
    setResolving(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setNotes((current) => current.filter((n) => n.id !== id))
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="lg:col-span-2">
        <SectionCard title="Leave a note">
          <p className="text-sm text-muted-foreground">
            Anything the next shift should know — unpaid tables, low stock, VIP bookings.
          </p>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, 500))}
            placeholder="e.g. Table 7 hasn't paid · Chicken stock low · VIP booking 7 PM"
            rows={4}
            className="mt-3"
          />
          <Button onClick={add} loading={busy} disabled={!body.trim()} className="mt-3">
            <Send /> Leave note
          </Button>
        </SectionCard>
      </div>

      <div className="lg:col-span-3">
        <SectionCard title={`Open notes (${notes.length})`}>
          {notes.length === 0 ? (
            <EmptyState
              className="border-dashed py-8"
              title="All caught up"
              description="No open handover notes. Anything you add appears here for the next shift."
            />
          ) : (
            <ul className="divide-y">
              {notes.map((n) => (
                <li key={n.id} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-sm">{n.body}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {n.authorName} · {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    loading={resolving === n.id}
                    onClick={() => done(n.id)}
                  >
                    <Check /> Done
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
