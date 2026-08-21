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
  return {
    message: 'That did not work. Try again, and tell us if it keeps happening.',
    expired: false,
  }
}

export const TRANSPORT_FAILED = 'TRANSPORT_FAILED'

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
  try {
    return await call()
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
          if (result.code === TRANSPORT_FAILED) {
            // Only the wrapper knows whether this was an expired session, and
            // only it can send the user somewhere useful.
            const next = typeof window !== 'undefined' ? window.location.pathname : '/dashboard'
            if (/session expired/i.test(result.error)) {
              router.push(`/login?next=${encodeURIComponent(next)}`)
            }
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
