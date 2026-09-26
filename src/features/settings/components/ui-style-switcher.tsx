'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check } from 'lucide-react'

import { SectionCard } from '@/features/dashboard/components/page-header'
import { UI_STYLES, readUiStyleCookie, writeUiStyleCookie, type UiStyle } from '@/features/dashboard/ui-style'
import { cn } from '@/lib/utils'

/**
 * Interface style — classic (default) or modern.
 *
 * Writes the cookie and refreshes, so the layout re-renders the shell in the
 * chosen style on the next frame. Nothing is saved to the account: it is a
 * per-browser preference, like the theme toggle beside the bell.
 */
export function UiStyleSwitcher() {
  const router = useRouter()
  const [style, setStyle] = React.useState<UiStyle>('classic')

  React.useEffect(() => setStyle(readUiStyleCookie()), [])

  const choose = (next: UiStyle) => {
    setStyle(next)
    writeUiStyleCookie(next)
    router.refresh()
  }

  return (
    <SectionCard
      title="Interface style"
      description="How the dashboard looks in this browser. Every tab changes together; nothing about what they do changes."
    >
      <div role="radiogroup" aria-label="Interface style" className="grid gap-3 sm:grid-cols-2">
        {UI_STYLES.map((option) => {
          const active = option.value === style
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(option.value)}
              className={cn(
                'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/60',
              )}
            >
              <Preview style={option.value} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {option.label}
                  {option.value === 'classic' ? (
                    <span className="text-xs font-normal text-muted-foreground">Default</span>
                  ) : null}
                  {active ? <Check className="ml-auto size-4 text-primary" /> : null}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
              </span>
            </button>
          )
        })}
      </div>
    </SectionCard>
  )
}

/** A thumbnail of the shell in each style, drawn with the same two colours it uses. */
function Preview({ style }: { style: UiStyle }) {
  const modern = style === 'modern'
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-14 w-20 shrink-0 overflow-hidden rounded-md border',
        modern ? 'bg-[#f4f6fb]' : 'bg-[#eef1f8]',
      )}
    >
      <span className={cn('h-full w-6', modern ? 'bg-[#0f1b33]' : 'bg-white/80')} />
      <span className="flex flex-1 flex-col gap-1 p-1.5">
        <span className={cn('h-1.5 w-8 rounded-sm', modern ? 'bg-[#2563eb]' : 'bg-[#f2711c]')} />
        <span className="h-4 rounded-sm bg-white shadow-sm" />
        <span className="h-3 rounded-sm bg-white shadow-sm" />
      </span>
    </span>
  )
}
