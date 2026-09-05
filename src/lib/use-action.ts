'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import type { ActionResult } from '@/lib/action'

/**
 * Calling a server action from a client component, safely.
 *
 * Every form in this app used to hand-roll this:
 *
 *     setBusy(true)
 *     const result = await someAction(payload)
 *     setBusy(false)              // ← never runs if the promise REJECTS
 *     if (!result.ok) ...
 *
 * `runAction` on the server turns every *business* failure into `{ok:false}`,
 * so that shape looked safe. It is not, because an action can also fail in
 * transport, before any result exists: an expired session, a dropped
 * connection, a serverless timeout, a deploy swapping the bundle mid-click.
 * Next's action client rejects the promise in each of those cases. The reset is
 * then skipped, and since these buttons are `disabled={busy}` they are left
 * reading "Adding…" forever, permanently disabled, with no message — the
 * failure and the evidence of it destroyed together. That one omission
 * accounted for every "stuck button" report, across 29 components.
 *
 * `callAction` is the fix: it converts a rejection into an ordinary
 * `{ok:false}` result, so the promise NEVER rejects and existing handlers keep
 * working unchanged. `useAction` builds the whole busy/toast/refresh cycle on
 * top for the common case.
 */

/** Transport failures Next surfaces as a rejected promise rather than a result. */
function describe(error: unknown): { message: string; expired: boolean } {
  const raw = error instanceof Error ? error.message : String(error)

  // Middleware no longer answers server actions, so this should be unreachable.
  // Kept because the alternative to a wrong-but-clear message is a silent hang.
  if (/session|sign in|401|unauthor/i.test(raw)) {
    return { message: 'Your session expired. Sign in again to continue.', expired: true }
  }
  if (/permission|forbidden|403/i.test(raw)) {
    return { message: 'You do not have permission to do that.', expired: false }
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return {
      message: 'Could not reach the server. Check your connection and try again.',
      expired: false,
    }
  }
  // Next's own wording when a deploy replaced the bundle this page was built from.
  if (/was not found on the server/i.test(raw)) {
    return { message: 'The app was updated. Refresh the page and try again.', expired: false }
  }

  /*
   * Nothing recognised, which in production means the server threw and React
   * replaced the message with a placeholder — deliberately, so an unfiltered
   * error cannot leak table and column names to whoever is looking at the
   * screen. It attaches a `digest` instead, and that number is the only thing
   * linking what the user saw to the real cause in the server log.
   *
   * This message used to end at "keeps happening", which is precisely the
   * report nobody can act on. Showing the reference turns it into a lookup:
   * paste it into /api/health/errors and the actual exception comes back.
   */
  const digest =
    error && typeof error === 'object' && 'digest' in error
      ? String((error as { digest?: unknown }).digest ?? '')
      : ''

  return {
    message: digest
      ? `That did not work — reference ${digest}. Check Settings → Diagnostics, or send us that number.`
      : 'That did not work, and the server gave no reason — it may have timed out. Try again.',
    expired: false,
  }
}

export const TRANSPORT_FAILED = 'TRANSPORT_FAILED'

/**
 * The browser reported no network, so nothing was attempted.
 *
 * Distinct from TRANSPORT_FAILED on purpose: that one means "we tried and
 * something went wrong", which invites a retry. This one means "we did not
 * try, and nothing was remembered", which is what an operator has to know
 * before deciding whether to take the money again.
 */
export const OFFLINE = 'OFFLINE'

/**
 * The session is gone and a silent refresh could not bring it back.
 *
 * A code, not a regex over an English sentence. The old check was
 * `/session expired/i.test(result.error)`, fed by a classifier that matched
 * `/session|sign in|401|unauthor/i` against whatever text an error carried —
 * in an application with cash-drawer sessions, a `sessions` table and a
 * `/cashier/session` route. It only ever fired on rejected promises, so it was
 * latent rather than live, but a control that works by accident of wording is
 * one wording change from working the other way.
 */
export const SESSION_EXPIRED = 'SESSION_EXPIRED'

/**
 * Wrap a server action call so it always resolves.
 *
 * For handlers that own their loading state — several screens track two or
 * three independent ones, where a single shared flag would disable the wrong
 * button. Wrapping the call is then the whole change:
 *
 *     const result = await callAction(() => someAction(payload))
 *
 * Prefer `useAction` for the ordinary one-button case.
 */
export async function callAction<T>(
  call: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  /*
   * Offline: refuse plainly, before trying (production.md §6).
   *
   * There is no offline write queue in this application and there deliberately
   * is not one — §6 warns against allowing dangerous financial operations
   * offline, and the money core is built on row locks that a queued write
   * cannot take. `src/app/offline/page.tsx` says so in as many words: nothing
   * entered while offline is saved.
   *
   * What was missing was saying it at the moment somebody tries. Attempting the
   * action offline produced a generic "Could not reach the server", which reads
   * like a glitch worth retrying, on a screen where the honest answer is
   * different in kind: this will not work until you are back, and nothing has
   * been remembered. A cashier who believes a settle is queued will not take
   * the money again.
   *
   * `navigator.onLine` is only reliable in the negative direction — false means
   * genuinely no network, true can still mean a captive portal — which is
   * exactly the direction being used here.
   */
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      ok: false,
      error:
        'You are offline, so this was not saved — nothing has been queued. ' +
        'Reconnect and do it again.',
      code: OFFLINE,
    }
  }

  try {
    const result = await call()

    /*
     * ── An unauthorised result gets one silent refresh and one retry ────────
     *
     * `UNAUTHORIZED` from an action means `requirePermission` refused BEFORE
     * the handler ran: nothing was written, nothing was charged, nothing
     * happened. That is what makes the retry safe by construction — and money
     * operations carry idempotency keys as a second net regardless. The refresh
     * itself is deduplicated across the tab, so ten failing buttons make one
     * request. If the refresh says there is no session to renew, the caller is
     * told so with a code it can act on, not a sentence it has to parse.
     *
     * `TRANSPORT_FAILED` (the catch below) is NEVER retried here: a rejected
     * promise means the request may have executed and the reply was lost, which
     * is the one case where "try again" can mean "do it twice".
     */
    if (!result.ok && result.code === 'UNAUTHORIZED') {
      const { requestSessionRefresh } = await import('@/lib/session-refresh')
      const renewed = await requestSessionRefresh()
      if (renewed) {
        const retried = await call()
        if (retried.ok || retried.code !== 'UNAUTHORIZED') return retried
      }
      return {
        ok: false,
        error: 'Your session expired. Sign in again to continue.',
        code: SESSION_EXPIRED,
      }
    }

    return result
  } catch (error) {
    // Logged so the digest in the server log can be matched to the click.
    console.error('[action]', error)
    const { message } = describe(error)
    return { ok: false, error: message, code: TRANSPORT_FAILED }
  }
}

interface RunOptions<T> {
  /** Toast on success. A string, or built from the returned data. */
  success?: string | ((data: T) => string)
  /** Runs only after a genuine success — close the dialog, refresh, navigate. */
  onDone?: (data: T) => void | Promise<void>
  /** Handle the failure yourself (inline field errors); suppresses the toast. */
  onFail?: (result: Extract<ActionResult<T>, { ok: false }>) => void
}

export function useAction() {
  const [busy, setBusy] = React.useState(false)
  const router = useRouter()
  // A component can unmount mid-flight (dialog closed, row deleted). Setting
  // state then is a React warning at best and a leak at worst.
  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = React.useCallback(
    async <T,>(
      call: () => Promise<ActionResult<T>>,
      options: RunOptions<T> = {},
    ): Promise<T | null> => {
      setBusy(true)
      try {
        const result = await callAction(call)

        if (!result.ok) {
          if (options.onFail) options.onFail(result)
          else toast.error(result.error)
          if (result.code === SESSION_EXPIRED) {
            // `callAction` has already tried a silent refresh and a retry; a
            // SESSION_EXPIRED here means there is genuinely nothing to renew.
            // Admin pages sign back in at the admin door.
            const { loginPathFor } = await import('@/lib/session-refresh')
            const here = typeof window !== 'undefined' ? window.location.pathname : '/dashboard'
            router.push(loginPathFor(here))
          }
          return null
        }

        if (options.success) {
          const text =
            typeof options.success === 'function' ? options.success(result.data) : options.success
          toast.success(text)
        }
        await options.onDone?.(result.data)
        return result.data
      } finally {
        // The reset lives here and nowhere else, so `busy` cannot survive a
        // failure of any kind.
        if (alive.current) setBusy(false)
      }
    },
    [router],
  )

  return { busy, run }
}
