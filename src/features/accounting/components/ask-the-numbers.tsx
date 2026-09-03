'use client'

import * as React from 'react'
import Link from 'next/link'
import { MessageCircleQuestion } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { cn } from '@/lib/utils'

/**
 * Ask the numbers (acCal.md §18) — deliberately NOT an AI. Every question in
 * the list was answered on the server from the real report engines before
 * this component rendered; typing only finds the closest question. An answer
 * always names its sources, and nothing here can invent a figure.
 */

export interface NumbersAnswer {
  id: string
  question: string
  /** Keywords the finder matches on, beyond the question text itself. */
  keywords: string[]
  answer: string
  table?: Array<{ label: string; value: string }>
  sources: Array<{ label: string; href: string }>
}

export function AskTheNumbers({ answers }: { answers: NumbersAnswer[] }) {
  const [query, setQuery] = React.useState('')
  const [openId, setOpenId] = React.useState<string | null>(null)

  const trimmed = query.trim().toLowerCase()
  const words = trimmed.split(/\s+/).filter((word) => word.length >= 3)
  const scored =
    words.length === 0
      ? null
      : answers
          .map((entry) => {
            const haystack = `${entry.question} ${entry.keywords.join(' ')}`.toLowerCase()
            const score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0)
            return { entry, score }
          })
          .filter((row) => row.score > 0)
          .sort((a, b) => b.score - a.score)

  const closest = scored && scored.length > 0 ? scored[0].entry : null
  const shown = closest ? [closest, ...answers.filter((entry) => entry.id !== closest.id)] : answers
  const active = openId ?? (closest ? closest.id : null)

  return (
    <SectionCard
      title="Ask the numbers"
      description="Pick a question — the answer comes from your real records and names its source. No AI, no guessing."
    >
      <div className="mb-3 flex items-center gap-2">
        <MessageCircleQuestion className="size-4 shrink-0 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpenId(null)
          }}
          placeholder="e.g. why did profit decrease?"
          className="max-w-md"
        />
      </div>
      {closest ? (
        <p className="mb-2 text-xs text-muted-foreground">Closest question: “{closest.question}”</p>
      ) : trimmed.length > 0 ? (
        <p className="mb-2 text-xs text-muted-foreground">
          No matching question yet — these are the ones the numbers can answer today.
        </p>
      ) : null}
      <ul className="divide-y">
        {shown.map((entry) => {
          const open = active === entry.id
          return (
            <li key={entry.id} className="py-2">
              <button
                type="button"
                onClick={() => setOpenId(open ? '' : entry.id)}
                className={cn(
                  'w-full text-left text-sm font-medium underline-offset-2 hover:underline',
                  open && 'text-primary',
                )}
              >
                {entry.question}
              </button>
              {open ? (
                <div className="mt-2 rounded-lg border bg-muted/30 p-3 text-sm">
                  <p>{entry.answer}</p>
                  {entry.table && entry.table.length > 0 ? (
                    <dl className="mt-2 grid gap-1">
                      {entry.table.map((row) => (
                        <div key={row.label} className="flex items-baseline justify-between gap-4">
                          <dt className="text-muted-foreground">{row.label}</dt>
                          <dd className="font-medium tabular-nums">{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  <p className="mt-2 flex flex-wrap gap-3 text-xs">
                    <span className="text-muted-foreground">Source:</span>
                    {entry.sources.map((source) => (
                      <Link
                        key={source.href}
                        href={source.href}
                        className="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {source.label}
                      </Link>
                    ))}
                  </p>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </SectionCard>
  )
}
