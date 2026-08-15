'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'

import { isRealtimeEnabled, REALTIME_POLL_MS } from '@/lib/realtime/client'

/**
 * Keeps a page fresh when there is no realtime server (e.g. on Netlify).
 *
 * When realtime push is available this renders nothing and does nothing —
 * live events handle updates. Otherwise it re-fetches the route's server data
 * on an interval, and pauses while the tab is hidden to save resources.
 */
export function AutoRefresh({ intervalMs = REALTIME_POLL_MS }: { intervalMs?: number }) {
  const router = useRouter()

  React.useEffect(() => {
    if (isRealtimeEnabled()) return

    let timer: ReturnType<typeof setInterval> | null = null
    // A refresh re-runs every server query for the route. On a slow database a
    // refresh can outlast the interval, so never stack a second one on top of
    // an in-flight request — that is what turns a slow page into a stuck one.
    let inFlight = false
    let disposed = false

    const refresh = () => {
      if (inFlight || disposed || document.visibilityState !== 'visible') return
      inFlight = true
      React.startTransition(() => {
        router.refresh()
      })
      // `router.refresh()` gives no completion signal, so gate on a short floor
      // rather than letting the next tick pile on immediately.
      window.setTimeout(() => {
        inFlight = false
      }, Math.min(intervalMs, 2_000))
    }

    const start = () => {
      if (timer) return
      timer = setInterval(refresh, intervalMs)
    }

    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }

    // Only poll while the tab is actually being looked at. Coming back to a
    // backgrounded tab refreshes once, immediately, then resumes the interval.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refresh()
        start()
      } else {
        stop()
      }
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      stop()
      // Previously omitted — every mount leaked a listener, so navigating
      // between dashboard screens multiplied the refreshes fired on each focus.
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [router, intervalMs])

  return null
}
