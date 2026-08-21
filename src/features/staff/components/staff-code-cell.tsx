'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, RotateCw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useAction } from '@/lib/use-action'
import { regenerateSignInCode } from '../actions'

/**
 * A member of staff's sign-in code, with a way to issue a new one.
 *
 * The code is shown rather than hidden behind a reveal. It is printed on a card
 * in that person's pocket, and the only people who can load this page are the
 * owner and managers who could reset it anyway — hiding it would cost the owner
 * a click every time someone forgets theirs, and buy nothing.
 *
 * Staff hired before sign-in codes existed have none, and still use the
 * temporary password they were emailed. "Give code" issues their first one.
 */
export function StaffCodeCell({ userId, code }: { userId: string; code: string | null }) {
  const router = useRouter()
  const { busy, run } = useAction()
  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy — select the code and copy it by hand.')
    }
  }

  const regenerate = () =>
    run(() => regenerateSignInCode(userId), {
      success: (data) => `${data.name}: new code ${data.code}`,
      onDone: () => router.refresh(),
    })

  return (
    <div className="flex items-center gap-1.5">
      {code ? (
        <button
          type="button"
          onClick={copy}
          title="Copy"
          className="rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-xs tracking-wider hover:bg-muted"
        >
          {code}
          {copied ? (
            <Check className="ml-1.5 inline h-3 w-3 text-emerald-500" />
          ) : (
            <Copy className="ml-1.5 inline h-3 w-3 text-muted-foreground" />
          )}
        </button>
      ) : (
        <span className="text-xs text-muted-foreground">not set</span>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={regenerate}
        disabled={busy}
        title="Issue a new code. The old one stops working immediately."
      >
        <RotateCw className={`mr-1 h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
        {busy ? 'Issuing…' : code ? 'New code' : 'Give code'}
      </Button>
    </div>
  )
}
