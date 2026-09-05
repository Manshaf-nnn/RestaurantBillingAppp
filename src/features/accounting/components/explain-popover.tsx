'use client'

import * as React from 'react'
import Link from 'next/link'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Explanation } from '@/features/accounting/explain'
import { formatMoney, type CurrencyCode } from '@/lib/money'

/**
 * The [Explain] behind a number (acCal.md §3): the formula with the real
 * figures, one plain sentence, and links to the records. All data arrives
 * pre-computed from the server — this component can show nothing the card
 * did not already say.
 */
export function ExplainPopover({
  explanation,
  currency,
}: {
  explanation: Explanation
  currency: CurrencyCode
}) {
  const [open, setOpen] = React.useState(false)
  const money = (minor: number) => formatMoney(minor, currency)
  const showValue =
    explanation.valueKind === 'percent'
      ? `${explanation.value}%`
      : explanation.valueKind === 'count'
        ? String(explanation.value)
        : money(explanation.value)

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          // Cards are links; Explain must open the dialog, not navigate.
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }}
        className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2"
      >
        Why is this number?
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-md"
          onClick={(event) => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>
              {explanation.title}: {showValue}
            </DialogTitle>
            <DialogDescription>{explanation.sentence}</DialogDescription>
          </DialogHeader>
          {explanation.lines.length > 0 ? (
            <dl className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm">
              {explanation.lines.map((line) => (
                <div key={`${line.op}${line.label}`} className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">
                    {line.op === '−' ? '− ' : line.op === '+' ? '+ ' : line.op === '=' ? '= ' : ''}
                    {line.label}
                  </dt>
                  <dd className={line.op === '=' ? 'font-bold tabular-nums' : 'font-medium tabular-nums'}>
                    {money(line.amount)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="text-muted-foreground">View transactions:</span>
            {explanation.sources.map((source) => (
              <Link
                key={source.href}
                href={source.href}
                className="font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => setOpen(false)}
              >
                {source.label}
              </Link>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
