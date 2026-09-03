'use client'

import * as React from 'react'
import { Info } from 'lucide-react'

import { GLOSSARY, type GlossaryTerm } from '@/lib/glossary'
import { cn } from '@/lib/utils'

/**
 * The ⓘ beside an accounting term (acCal.md UI rules). Click to read one
 * plain sentence; click anywhere else to dismiss. Deliberately not hover-only
 * — the accountant is often on a tablet.
 */
export function InfoTip({ term, className }: { term: GlossaryTerm; className?: string }) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLSpanElement>(null)

  React.useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [open])

  return (
    <span ref={ref} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        aria-label="What does this mean?"
        aria-expanded={open}
        onClick={(event) => {
          // The card around a hub number is a link; the ⓘ must not follow it.
          event.preventDefault()
          event.stopPropagation()
          setOpen((value) => !value)
        }}
        className="text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2"
      >
        <Info className="size-3.5" />
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute left-1/2 top-full z-50 mt-1.5 w-56 -translate-x-1/2 rounded-lg border bg-popover p-2.5 text-xs font-normal normal-case leading-relaxed text-popover-foreground shadow-elevated"
        >
          {GLOSSARY[term]}
        </span>
      ) : null}
    </span>
  )
}
