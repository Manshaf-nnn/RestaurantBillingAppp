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

    const start = () => {
      if (timer) return
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') router.refresh()
      }, intervalMs)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }

    start()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') router.refresh()
    })

    return stop
  }, [router, intervalMs])

  return null
}
