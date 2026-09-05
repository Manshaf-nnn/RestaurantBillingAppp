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

/** One event from the transactional outbox. */
export interface PulseEvent {
  id: string
  seq: string
  type: string
  entity: string
  entityId: string | null
  branchId: string | null
  at: string
  payload?: unknown
}

type Listener = (token: string, events: PulseEvent[]) => void

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
  /**
   * The outbox cursor, or null while this poller does not want events.
   *
   * `'0'` is the "just started" value: the server answers with the current end
   * of the stream and no backlog, because a screen opening at 3pm has no
   * business replaying the lunch rush.
   */
  since: string | null
  /** Which branch's events to ask for; null means the whole restaurant. */
  branchId: string | null
  /**
   * Ids already delivered to listeners, so an event that arrives twice is
   * applied once.
   *
   * Bounded on purpose. A poller can run for a fourteen-hour service and an
   * unbounded Set would grow all day on a counter tablet; duplicates only ever
   * arrive close together (a retried request, an overlapping poll), so a
   * window of recent ids is all that is needed and the memory stays flat.
   */
  seen: Set<string>
  seenOrder: string[]
  /**
   * Consecutive 401s. One triggers a silent refresh; a second while the tab is
   * visible means the session is genuinely gone and the station is sent to
   * sign in rather than left showing yesterday's tickets.
   */
  unauthorised: number
}

/** How many recent event ids to remember for de-duplication. */
const SEEN_LIMIT = 500

const pollers = new Map<string, Poller>()

/**
 * The scope name IS the poller key, so two screens watching different things
 * get their own poller and their own token — which is the point. A till
 * watching `catalog` must not be woken by the kitchen, and it is the key here
 * that keeps them apart.
 */
function urlFor(scope: string, poller: Poller): string {
  if (scope.startsWith('order:')) {
    return `/api/pulse?orderId=${encodeURIComponent(scope.slice('order:'.length))}`
  }
  // `staff` is the historical name for the operational scope; keep it meaning
  // the same thing rather than renaming eleven existing call sites.
  const name = scope === 'staff' || scope === 'ops' ? 'ops' : scope
  let url = `/api/pulse?scope=${encodeURIComponent(name)}`

  // Events are opt-in: a screen that only wants "did anything change" costs the
  // server exactly what it always did.
  if (poller.since !== null) {
    url += `&since=${encodeURIComponent(poller.since)}`
    if (poller.branchId) url += `&branchId=${encodeURIComponent(poller.branchId)}`
  }
  return url
}

/** Remember an id as delivered, evicting the oldest once the window is full. */
function remember(poller: Poller, id: string) {
  if (poller.seen.has(id)) return
  poller.seen.add(id)
  poller.seenOrder.push(id)
  while (poller.seenOrder.length > SEEN_LIMIT) {
    const oldest = poller.seenOrder.shift()
    if (oldest) poller.seen.delete(oldest)
  }
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
  // Set when a silent refresh succeeded: poll again straight away instead of
  // waiting out the interval. Done from `finally`, not by recursing here — a
  // nested `tick` would see `inFlight` still true and return without polling.
  let pollAgainNow = false
  try {
    const response = await fetch(urlFor(scope, poller), {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })

    /*
     * ── A 401 is not a network blip ─────────────────────────────────────────
     *
     * It used to be: every non-OK status fell into the same failure counter
     * and the same back-off, so a station whose session had ended kept polling
     * more and more slowly, never got a token change, never refreshed, and sat
     * showing stale tickets with no indication anything was wrong. `/api/pulse`
     * catches its own database errors and answers 200, so a 401 from it means
     * one thing only: no session.
     *
     * First 401 → one silent refresh (deduplicated across the tab, and at most
     * once a minute from this poller), then poll again straight away. Second
     * 401 in a row while the tab is visible → the session is genuinely gone;
     * send the station to sign in, which is what the spec means by "an
     * expired session still forces a login". Hidden tabs are left alone: a
     * screen nobody is looking at should not navigate itself.
     */
    if (response.status === 401) {
      poller.unauthorised += 1
      if (poller.unauthorised === 1) {
        const { requestSessionRefresh } = await import('@/lib/session-refresh')
        if (await requestSessionRefresh(60_000)) {
          poller.unauthorised = 0
          poller.failures = 0
          pollAgainNow = true
          return
        }
      }
      if (poller.unauthorised >= 2 && typeof document !== 'undefined' && document.visibilityState === 'visible') {
        const { loginPathFor } = await import('@/lib/session-refresh')
        window.location.assign(loginPathFor(window.location.pathname))
        return
      }
      throw new Error('401')
    }
    if (!response.ok) throw new Error(String(response.status))
    poller.unauthorised = 0

    const body = (await response.json()) as {
      v?: string | null
      seq?: string | null
      events?: PulseEvent[]
      truncated?: boolean
    }
    poller.failures = 0

    /*
     * Advance the cursor and drop anything already seen.
     *
     * `truncated` means more events were waiting than one page holds — a
     * screen that was asleep, or a very busy minute. The cursor still advances,
     * because the token below guarantees the screen refreshes anyway and
     * replaying a long backlog event by event would be slower and no more
     * correct than one refresh.
     */
    const fresh: PulseEvent[] = []
    if (poller.since !== null && body.seq) {
      poller.since = body.seq
      for (const event of body.events ?? []) {
        if (poller.seen.has(event.id)) continue
        remember(poller, event.id)
        fresh.push(event)
      }
    }

    const token = body.v ?? null
    if (token !== null) {
      const changed = poller.token !== null && poller.token !== token
      poller.token = token
      /*
       * The token is the safety net, and it is why a skipped event cannot
       * cause a missed update.
       *
       * The outbox cursor can step over an event: Postgres assigns `seq` at
       * INSERT and publishes at COMMIT, so a slow transaction can commit seq 10
       * after seq 11 is already visible. The token is derived from
       * MAX(updatedAt) and cannot miss a change — it just cannot say what
       * changed. So the refresh fires on the token, and the events only ever
       * ADD detail to it.
       *
       * The first successful poll only establishes a baseline; firing then
       * would make every screen refresh once for no reason on mount.
       */
      if (changed) {
        for (const listener of poller.listeners) listener(token, fresh)
      }
    }
  } catch {
    poller.failures += 1
  } finally {
    poller.inFlight = false
    if (pollAgainNow) void tick(scope, poller)
    else schedule(scope, poller)
  }
}

function acquire(
  scope: string,
  intervalMs: number,
  listener: Listener,
  options: { events?: boolean; branchId?: string | null } = {},
): () => void {
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
      since: options.events ? '0' : null,
      branchId: options.branchId ?? null,
      seen: new Set(),
      seenOrder: [],
      unauthorised: 0,
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
    // …and if any of them wants events, the shared poller fetches them.
    if (options.events && poller.since === null) poller.since = '0'
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
  onChange: (events: PulseEvent[]) => void,
  enabled = true,
  options: { events?: boolean; branchId?: string | null } = {},
) {
  const saved = React.useRef(onChange)
  React.useEffect(() => {
    saved.current = onChange
  }, [onChange])

  const { events, branchId } = options
  React.useEffect(() => {
    if (!enabled) return
    return acquire(scope, intervalMs, (_token, delivered) => saved.current(delivered), {
      events,
      branchId,
    })
  }, [scope, intervalMs, enabled, events, branchId])
}
