'use client'

import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Search, X } from 'lucide-react'

import { Input } from '@/components/ui/input'

/**
 * A search box that writes to the URL.
 *
 * Server-side search, because these tables are the ones that grow: a client
 * filter over a `take: 200` slice searches the two hundred rows that happened
 * to be fetched and confidently reports "no results" for the row sitting at
 * 201. The URL is the state, so a search can be bookmarked, sent to someone,
 * and survives the back button.
 *
 * Debounced rather than submit-on-Enter. The orders table — the only screen
 * that had server-side search before this — only searched when you pressed
 * Enter, with no submit button and nothing saying so, and it reads as a broken
 * box until you happen to try.
 *
 * Typing resets to page 1. Staying on page 4 of the old result set while the
 * new one has two pages shows an empty table, which reads as "no results" when
 * there are plenty.
 */
export function SearchBox({
  placeholder = 'Search…',
  defaultValue = '',
  paramName = 'search',
  delayMs = 300,
  className,
}: {
  placeholder?: string
  defaultValue?: string
  paramName?: string
  delayMs?: number
  className?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [value, setValue] = React.useState(defaultValue)

  // Keep in step when the URL changes underneath us — back button, a link that
  // carries a different term, or a server-driven reset.
  React.useEffect(() => {
    setValue(searchParams.get(paramName) ?? '')
  }, [searchParams, paramName])

  const commit = React.useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next.trim()) params.set(paramName, next.trim())
      else params.delete(paramName)
      params.delete('page')

      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams, paramName],
  )

  React.useEffect(() => {
    const current = searchParams.get(paramName) ?? ''
    if (value === current) return

    const timer = setTimeout(() => commit(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, commit, delayMs, searchParams, paramName])

  return (
    <div className={className}>
      <Input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        startIcon={<Search className="size-4" />}
        endIcon={
          value ? (
            <button
              type="button"
              onClick={() => {
                setValue('')
                commit('')
              }}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null
        }
      />
    </div>
  )
}
