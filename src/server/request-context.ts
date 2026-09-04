import 'server-only'

import { headers } from 'next/headers'

import { getCurrentUser } from '@/server/auth/session'

/**
 * Who and where, for an error record (production.md §7).
 *
 * §7 asks that an important error carry a request id, the restaurant, the
 * branch where applicable and the user where appropriate. Every one of those is
 * already available inside a request — it simply was never gathered, because
 * nothing was writing errors from inside one.
 *
 * ── Why the identity comes from the session, not a header ───────────────────
 *
 * The same rule the rest of the application follows: `restaurantId` is derived
 * from the verified session cookie and never from anything the caller sent. An
 * error record naming a restaurant is a small thing, but a caller who could
 * choose which restaurant their errors were filed against could use the error
 * centre to tell one tenant a story about another.
 *
 * ── Failing quietly ─────────────────────────────────────────────────────────
 *
 * Every lookup here is best-effort. This runs while something has already gone
 * wrong, sometimes outside a request scope entirely (a background job), and an
 * error thrown while describing an error destroys the original — which is the
 * one thing that must not happen.
 */

/** The header a proxy or load balancer may already have set. */
const REQUEST_ID_HEADERS = ['x-request-id', 'x-correlation-id', 'x-vercel-id', 'x-nf-request-id']

/**
 * The current request's correlation id.
 *
 * Prefers an id the edge already assigned, so a line in the platform's own logs
 * and a row in `error_logs` can be matched to each other. Falls back to the one
 * the proxy sets on the way in.
 */
export async function currentRequestId(): Promise<string | null> {
  try {
    const store = await headers()
    for (const name of REQUEST_ID_HEADERS) {
      const value = store.get(name)
      if (value) return value.slice(0, 200)
    }
    return null
  } catch {
    // Not in a request scope — a background job, or a script.
    return null
  }
}

export interface ErrorContext {
  requestId: string | null
  route: string | null
  restaurantId: string | null
  branchId: string | null
  userId: string | null
}

/** Everything about the current request worth attaching to an error. */
export async function currentErrorContext(): Promise<ErrorContext> {
  const context: ErrorContext = {
    requestId: null,
    route: null,
    restaurantId: null,
    branchId: null,
    userId: null,
  }

  try {
    const store = await headers()
    for (const name of REQUEST_ID_HEADERS) {
      const value = store.get(name)
      if (value) {
        context.requestId = value.slice(0, 200)
        break
      }
    }
    // Next sets this on Server Action requests; it is the closest thing to a
    // route a Server Action has.
    context.route = store.get('next-url') ?? store.get('referer') ?? null
    if (context.route) context.route = context.route.slice(0, 300)
  } catch {
    // Outside a request scope; the ids below will be null too.
  }

  try {
    const user = await getCurrentUser()
    if (user) {
      context.userId = user.id
      context.restaurantId = user.restaurantId ?? null
      context.branchId = user.branchId ?? null
    }
  } catch {
    // Signed out, expired, or not a request — an anonymous error is still worth
    // recording, and is often the interesting one.
  }

  return context
}
