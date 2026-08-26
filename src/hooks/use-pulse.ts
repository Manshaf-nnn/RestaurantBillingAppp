'use client'

import * as React from 'react'

/**
 * Shared change detector for hosts without a websocket server.
 *
 * One poller per scope per browser tab, however many components subscribe — a
 * dashboard with six live panels issues one request, not six. Each request hits
 * `/api/pulse`, which returns a small token, and subscribers are only notified
 * when that token actually changes.
 *
 * Polling stops entirely while the tab is hidden and resumes with an immediate
 * check on return, so a station left open overnight costs nothing.
 */

type Listener = (token: string) => void

interface Poller {
  listeners: Set<Listener>
  token: string | null
  timer: ReturnType<typeof setTimeout> | null
  intervalMs: number
  stopped: boolean
  inFlight: boolean
  /** consecutive failures, used to back off instead of hammering a sick server */
  failures: number
  onVisibility: () => void
}

const pollers = new Map<string, Poller>()

/**
 * The scope name IS the poller key, so two screens watching different things
 * get their own poller and their own token — which is the point. A till
 * watching `catalog` must not be woken by the kitchen, and it is the key here
 * that keeps them apart.
 */
function urlFor(scope: string): string {
  if (scope.startsWith('order:')) {
    return `/api/pulse?orderId=${encodeURIComponent(scope.slice('order:'.length))}`
  }
  // `staff` is the historical name for the operational scope; keep it meaning
  // the same thing rather than renaming eleven existing call sites.
  if (scope === 'staff' || scope === 'ops') return '/api/pulse?scope=ops'
  return `/api/pulse?scope=${encodeURIComponent(scope)}`
}

function schedule(scope: string, poller: Poller) {
  if (poller.stopped || poller.timer) return
  // Exponential back-off on repeated failure, capped — a station should recover
  // on its own once the network or database comes back.
  const delay = poller.failures > 0
    ? Math.min(poller.intervalMs * 2 ** Math.min(poller.failures, 4), 60_000)
    : poller.intervalMs

  poller.timer = setTimeout(() => {
    poller.timer = null
    void tick(scope, poller)
  }, delay)
}

async function tick(scope: string, poller: Poller) {
  if (poller.stopped || poller.inFlight) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return

  poller.inFlight = true
  try {
    const response = await fetch(urlFor(scope), {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(String(response.status))

    const body = (await response.json()) as { v?: string | null }
    poller.failures = 0

    const token = body.v ?? null
    if (token !== null) {
      const changed = poller.token !== null && poller.token !== token
      poller.token = token
      // The first successful poll only establishes a baseline; firing then would
      // make every screen refresh once for no reason on mount.
      if (changed) {
        for (const listener of poller.listeners) listener(token)
      }
    }
  } catch {
    poller.failures += 1
  } finally {
    poller.inFlight = false
    schedule(scope, poller)
  }
}

function acquire(scope: string, intervalMs: number, listener: Listener): () => void {
  let poller = pollers.get(scope)

  if (!poller) {
    const created: Poller = {
      listeners: new Set(),
      token: null,
      timer: null,
      intervalMs,
      stopped: false,
      inFlight: false,
      failures: 0,
      onVisibility: () => {},
    }
    created.onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Check straight away rather than waiting out the interval.
        void tick(scope, created)
      } else if (created.timer) {
        clearTimeout(created.timer)
        created.timer = null
      }
    }
    document.addEventListener('visibilitychange', created.onVisibility)
    pollers.set(scope, created)
    poller = created
    void tick(scope, created)
  } else {
    // Several screens can share a scope; honour the most responsive one.
    poller.intervalMs = Math.min(poller.intervalMs, intervalMs)
  }

  poller.listeners.add(listener)

  return () => {
    const current = pollers.get(scope)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      current.stopped = true
      if (current.timer) clearTimeout(current.timer)
      current.timer = null
      document.removeEventListener('visibilitychange', current.onVisibility)
      pollers.delete(scope)
    }
  }
}

/**
 * Run `onChange` whenever the server reports that something changed.
 *
 * @param scope       `'staff'` for the signed-in restaurant, or `order:<id>` for a guest.
 * @param intervalMs  how often to check.
 * @param onChange    called only on an actual change, never on the first poll.
 * @param enabled     set false to stay idle (e.g. when a real websocket is connected).
 */
export function usePulse(
  scope: string,
  intervalMs: number,
  onChange: () => void,
  enabled = true,
) {
  const saved = React.useRef(onChange)
  React.useEffect(() => {
    saved.current = onChange
  }, [onChange])

  React.useEffect(() => {
    if (!enabled) return
    return acquire(scope, intervalMs, () => saved.current())
  }, [scope, intervalMs, enabled])
}
