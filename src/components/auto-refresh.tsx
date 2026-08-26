'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'

import { isRealtimeEnabled, REALTIME_POLL_MS } from '@/lib/realtime/client'
import { usePulse } from '@/hooks/use-pulse'

/**
 * Keeps a page fresh when there is no realtime server (e.g. on Netlify).
 *
 * When realtime push is available this renders nothing and does nothing —
 * live events handle updates.
 *
 * Otherwise it watches `/api/pulse`, a single cheap query that reports whether
 * anything changed, and only re-renders the route when it actually did.
 * Re-rendering blind on a timer meant re-running every query on the page just to
 * discover nothing had happened; checking is now cheap enough to do far more
 * often, so stations feel live while doing much less work overall.
 *
 * `scope` decides what "changed" means:
 *   'staff' / 'ops' — orders, items and service calls (kitchen, waiter, cashier,
 *                     dashboard). The two names are the same thing.
 *   'catalog'       — the menu and the stock behind it. What a till and the
 *                     admin CRUD screens need: adding a dish used to be
 *                     invisible everywhere until somebody reloaded the browser.
 *   'live'          — ops plus the floor and its customers; the live board.
 *   'order:<id>'    — one guest's order (tracking, bill)
 *   'none'          — no pulse available (the platform admin console, which is
 *                     not scoped to a restaurant); falls back to a plain timer.
 *
 * Pick the narrowest scope that covers the screen. A refresh re-renders the
 * whole route, so watching more than you need is not free — it is the reason
 * these are separate at all.
 */
export function AutoRefresh({
  intervalMs = REALTIME_POLL_MS,
  scope = 'staff',
  onChange,
}: {
  intervalMs?: number
  scope?: string
  /** Extra work on a detected change — e.g. the kitchen's new-order chime. */
  onChange?: () => void
}) {
  const router = useRouter()
  const live = isRealtimeEnabled()

  const refresh = React.useCallback(() => {
    onChange?.()
    React.startTransition(() => {
      router.refresh()
    })
  }, [router, onChange])

  usePulse(scope, intervalMs, refresh, !live && scope !== 'none')

  // Fallback for scopes the pulse cannot describe.
  React.useEffect(() => {
    if (live || scope !== 'none') return

    let timer: ReturnType<typeof setInterval> | null = null

    const run = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    const start = () => {
      if (!timer) timer = setInterval(run, intervalMs)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
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
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [live, scope, intervalMs, refresh])

  return null
}
