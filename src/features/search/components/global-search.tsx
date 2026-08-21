'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { callAction } from '@/lib/use-action'
import { globalSearchAction } from '../actions'
import type { SearchHit } from '../service'

/**
 * The search box in the top bar.
 *
 * There was no global search of any kind before this — not a broken one, not
 * even a decorative input — so finding a purchase order meant knowing which
 * screen listed purchase orders and reading down it.
 *
 * Notes on the behaviour, each for a reason:
 *
 * · **Debounced, and the response is checked against the query it was for.**
 *   Typing "rice" fires several searches and they can come back out of order;
 *   without the check, "ric" landing after "rice" would replace correct results
 *   with stale ones and the box would look broken in a way that is very hard to
 *   reproduce deliberately.
 *
 * · **Two characters minimum**, below which a search matches half the database.
 *   The box says so rather than sitting empty and looking dead.
 *
 * · **Keyboard first.** ⌘K opens it, arrows move, Enter follows, Escape closes.
 *   Someone at a till has one hand on a screen and the other on a docket.
 *
 * · **Every state is stated.** Searching, nothing typed yet, nothing found —
 *   three different messages, because "no results" shown while a request is
 *   still in flight is the single most common way a working search gets
 *   reported as broken.
 */
export function GlobalSearch() {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [term, setTerm] = React.useState('')
  const [hits, setHits] = React.useState<SearchHit[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [active, setActive] = React.useState(0)

  // The query the newest in-flight request was for.
  const latest = React.useRef('')

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  React.useEffect(() => {
    if (!open) {
      setTerm('')
      setHits([])
      setTruncated(false)
      setActive(0)
    }
  }, [open])

  React.useEffect(() => {
    const query = term.trim()
    if (query.length < 2) {
      setHits([])
      setTruncated(false)
      setBusy(false)
      return
    }

    setBusy(true)
    const timer = setTimeout(async () => {
      latest.current = query
      const result = await callAction(() => globalSearchAction({ term: query }))

      // A slower earlier request must not overwrite a newer answer.
      if (latest.current !== query) return

      setBusy(false)
      if (!result.ok) {
        setHits([])
        return
      }
      setHits(result.data.hits)
      setTruncated(result.data.truncated)
      setActive(0)
    }, 250)

    return () => clearTimeout(timer)
  }, [term])

  const go = React.useCallback(
    (hit: SearchHit) => {
      setOpen(false)
      router.push(hit.href)
    },
    [router],
  )

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (hits.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (i + 1) % hits.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (i - 1 + hits.length) % hits.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const hit = hits[active]
      if (hit) go(hit)
    }
  }

  // Grouped for display, while `hits` stays flat so the arrow keys can walk it.
  const groups = React.useMemo(() => {
    const map = new Map<string, SearchHit[]>()
    for (const hit of hits) {
      const list = map.get(hit.group) ?? []
      list.push(hit)
      map.set(hit.group, list)
    }
    return [...map.entries()]
  }, [hits])

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="hidden gap-2 text-muted-foreground sm:flex"
        aria-label="Search"
      >
        <Search className="size-4" />
        <span className="hidden md:inline">Search…</span>
        <kbd className="hidden rounded border border-border bg-muted px-1.5 text-[10px] font-medium md:inline">
          ⌘K
        </kbd>
      </Button>

      {/* On a phone the button is icon-only; the shortcut is meaningless there. */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        className="sm:hidden"
        aria-label="Search"
      >
        <Search />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[12%] translate-y-0 gap-0 p-0" size="default">
          <DialogTitle className="sr-only">Search</DialogTitle>

          <div className="border-b border-border p-3">
            <Input
              autoFocus
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Items, suppliers, orders, deliveries, customers, staff…"
              startIcon={<Search className="size-4" />}
              endIcon={busy ? <Loader2 className="size-4 animate-spin" /> : null}
            />
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-2">
            {term.trim().length < 2 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Type at least two characters. Item names and codes, supplier names, order and GRN
                numbers, invoice references, customer names and phone numbers.
              </p>
            ) : busy && hits.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Searching…</p>
            ) : hits.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing matches “{term.trim()}”. Try part of a name or a number — searching is not
                case-sensitive and does not need the whole word.
              </p>
            ) : (
              <>
                {groups.map(([group, rows]) => (
                  <div key={group} className="mb-2 last:mb-0">
                    <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group}
                    </p>
                    <ul>
                      {rows.map((hit) => {
                        const index = hits.indexOf(hit)
                        return (
                          <li key={hit.id}>
                            <button
                              type="button"
                              onClick={() => go(hit)}
                              onMouseEnter={() => setActive(index)}
                              className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left ${
                                index === active ? 'bg-muted' : ''
                              }`}
                            >
                              <span className="text-sm font-medium">{hit.title}</span>
                              {hit.subtitle ? (
                                <span className="text-xs text-muted-foreground">{hit.subtitle}</span>
                              ) : null}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
                {truncated ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    Showing the closest few in each group. Narrow the search to see more.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
