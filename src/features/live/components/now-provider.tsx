'use client'

import * as React from 'react'

/**
 * One clock for the whole board.
 *
 * ── Why `now` starts as null ────────────────────────────────────────────────
 *
 * The server renders this page too, and its clock is not the browser's. Seeding
 * the state with `Date.now()` means the HTML says "31 min" and the first client
 * render says "32 min", and React throws a hydration mismatch — a failure this
 * codebase has already paid for twice (`components/ops-shell.tsx`,
 * `components/local-time.tsx`). So the server pass renders a placeholder and
 * every elapsed figure appears on the first effect tick, a frame later.
 *
 * ── And why there is only one ───────────────────────────────────────────────
 *
 * Twenty cards with twenty `setInterval`s is twenty timers drifting apart and
 * twenty renders a second. One interval, one context, one re-render — and it
 * stops entirely when the tab is hidden, so a screen left on the pass overnight
 * costs nothing. That mirrors `usePulse`, which already stops fetching when
 * hidden; without it the page would keep re-rendering against a server that had
 * stopped being asked anything.
 */

const NowContext = React.createContext<number | null>(null)

export function NowProvider({
  children,
  intervalMs = 1000,
}: {
  children: React.ReactNode
  intervalMs?: number
}) {
  const [now, setNow] = React.useState<number | null>(null)

  React.useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }
    tick()
    const timer = setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [intervalMs])

  return <NowContext.Provider value={now}>{children}</NowContext.Provider>
}

/** The shared clock. Null until the first tick — see the note above. */
export function useNow(): number | null {
  return React.useContext(NowContext)
}

/**
 * How long ago, counting up.
 *
 * `suppressHydrationWarning` sits on the element that actually holds the text,
 * because it only suppresses one level deep — putting it on a wrapper does
 * nothing.
 */
export function Elapsed({ since, suffix = 'min' }: { since: string; suffix?: string }) {
  const now = useNow()
  if (now === null) return <span suppressHydrationWarning>·</span>

  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000))
  return (
    <span suppressHydrationWarning className="tabular-nums">
      {minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} ${suffix}`}
    </span>
  )
}

/** The current time, for the header. Same hydration rule. */
export function Clock({ timeZone }: { timeZone: string }) {
  const now = useNow()
  if (now === null) return <span suppressHydrationWarning>—</span>

  return (
    <span suppressHydrationWarning className="tabular-nums">
      {new Intl.DateTimeFormat('en-GB', {
        timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      }).format(new Date(now))}
    </span>
  )
}
