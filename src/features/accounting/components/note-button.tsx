'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { StickyNote } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { callAction } from '@/lib/use-action'
import { addAccountantNoteAction } from '../actions'

export interface NoteRow {
  id: string
  body: string
  authorName: string
  createdAt: string
}

/**
 * The accountant's note pin (acCal.md §17). Shows how many notes a record
 * carries, opens the little history, takes a new one. Notes are append-only —
 * there is no edit and no delete here on purpose.
 */
export function NoteButton({
  entity,
  entityId,
  notes,
  canNote,
  compact = false,
}: {
  entity: 'invoice' | 'order' | 'payment' | 'outgoingPayment' | 'issue' | 'bankLine'
  entityId: string
  notes: NoteRow[]
  canNote: boolean
  compact?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [body, setBody] = React.useState('')
  const [pending, setPending] = React.useState(false)

  if (!canNote && notes.length === 0) return null

  const save = async () => {
    setPending(true)
    const result = await callAction(() => addAccountantNoteAction({ entity, entityId, body: body.trim() }))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setBody('')
    setOpen(false)
    router.refresh()
  }

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        title={notes[0] ? `${notes[0].authorName}: ${notes[0].body}` : 'Add a note'}
      >
        <StickyNote className="size-3.5" />
        {compact ? (notes.length > 0 ? notes.length : '+') : notes.length > 0 ? `Notes (${notes.length})` : 'Add note'}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Notes</DialogTitle>
            <DialogDescription>
              Signed and permanent — a wrong note is answered with another note, never erased.
            </DialogDescription>
          </DialogHeader>
          {notes.length > 0 ? (
            <ul className="max-h-56 space-y-2 overflow-y-auto text-sm">
              {notes.map((note) => (
                <li key={note.id} className="rounded-lg border bg-muted/30 p-2.5">
                  <p>{note.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {note.authorName} · {new Date(note.createdAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No notes yet.</p>
          )}
          {canNote ? (
            <div className="grid gap-2">
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="e.g. Supplier invoice corrected due to duplicate quantity."
                className="w-full rounded-lg border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2"
              />
              <Button loading={pending} disabled={body.trim().length === 0} onClick={save} className="justify-self-end">
                Add note
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
