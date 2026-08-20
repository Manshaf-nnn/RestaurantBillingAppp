'use client'

import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

/** Copies a staff sign-in link. Shown truncated — it is long and not readable. */
export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      toast.success('Link copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access is refused in some embedded browsers; showing the URL
      // at least lets it be copied by hand.
      toast.error('Could not copy — select the link and copy it manually')
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex max-w-[18rem] items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
      title={url}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="truncate">{url.replace(/^https?:\/\//, '')}</span>
    </button>
  )
}
