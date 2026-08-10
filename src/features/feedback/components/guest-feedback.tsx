'use client'

import * as React from 'react'
import { toast } from 'sonner'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { submitFeedback, submitSystemFeedback } from '../actions'

const FACES = [
  { r: 1, e: '😞', l: 'Bad' },
  { r: 2, e: '😐', l: 'Okay' },
  { r: 3, e: '🙂', l: 'Good' },
  { r: 4, e: '😍', l: 'Great' },
] as const

/** One-tap, anonymous feedback — no name, no email, so guests actually leave it. */
export function GuestFeedback({ tableNumber }: { tableNumber?: string | null }) {
  const [comment, setComment] = React.useState('')
  const [busy, setBusy] = React.useState<number | null>(null)
  const [sent, setSent] = React.useState(false)

  const send = async (rating: number) => {
    setBusy(rating)
    const result = await submitFeedback({ category: 'FOOD', rating, comment, tableNumber: tableNumber ?? '' })
    setBusy(null)
    if (result.ok) setSent(true)
    else toast.error(result.error)
  }

  if (sent) {
    return (
      <section className="surface p-4 text-center">
        <p className="text-2xl">🙏</p>
        <p className="mt-1 text-sm font-semibold">Thank you for your feedback!</p>
        <p className="text-xs text-muted-foreground">It helps us serve you better next time.</p>
      </section>
    )
  }

  return (
    <section className="surface p-4">
      <h2 className="text-sm font-semibold">How was everything?</h2>
      <p className="mb-3 text-xs text-muted-foreground">Anonymous — one tap, no details needed.</p>
      <div className="flex justify-between gap-2">
        {FACES.map((f) => (
          <button
            key={f.r}
            type="button"
            disabled={busy !== null}
            onClick={() => send(f.r)}
            className={cn(
              'flex flex-1 flex-col items-center gap-1 rounded-xl border py-3 transition-colors',
              'hover:border-primary hover:bg-primary/5 disabled:opacity-60',
              busy === f.r && 'border-primary bg-primary/10',
            )}
          >
            <span className="text-3xl">{f.e}</span>
            <span className="text-[11px] font-medium text-muted-foreground">{f.l}</span>
          </button>
        ))}
      </div>
      <Input
        value={comment}
        onChange={(event) => setComment(event.target.value.slice(0, 300))}
        placeholder="Add a comment (optional)"
        className="mt-3"
      />
    </section>
  )
}

export function SystemFeedback({ title = 'How was the system?', subtitle = 'Quick feedback about the platform' }: { title?: string; subtitle?: string }) {
  const [comment, setComment] = React.useState('')
  const [busy, setBusy] = React.useState<number | null>(null)
  const [sent, setSent] = React.useState(false)

  const send = async (rating: number) => {
    setBusy(rating)
    const result = await submitSystemFeedback({ category: 'SYSTEM', rating, comment })
    setBusy(null)
    if (result.ok) setSent(true)
    else toast.error(result.error)
  }

  if (sent) {
    return (
      <section className="surface p-4 text-center">
        <p className="text-2xl">🙏</p>
        <p className="mt-1 text-sm font-semibold">Thank you for the feedback!</p>
        <p className="text-xs text-muted-foreground">Your team can review this in the admin console.</p>
      </section>
    )
  }

  return (
    <section className="surface p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>
      <div className="flex justify-between gap-2">
        {FACES.map((f) => (
          <button
            key={f.r}
            type="button"
            disabled={busy !== null}
            onClick={() => send(f.r)}
            className={cn(
              'flex flex-1 flex-col items-center gap-1 rounded-xl border py-3 transition-colors',
              'hover:border-primary hover:bg-primary/5 disabled:opacity-60',
              busy === f.r && 'border-primary bg-primary/10',
            )}
          >
            <span className="text-3xl">{f.e}</span>
            <span className="text-[11px] font-medium text-muted-foreground">{f.l}</span>
          </button>
        ))}
      </div>
      <Input
        value={comment}
        onChange={(event) => setComment(event.target.value.slice(0, 300))}
        placeholder="Share a note (optional)"
        className="mt-3"
      />
    </section>
  )
}
