import 'server-only'
import { createHash } from 'node:crypto'
import { headers } from 'next/headers'

import { RateLimitError } from '@/lib/errors'
import { incrementCounter } from '@/server/cache/redis'

export interface RateLimitRule {
  /** Requests allowed inside the window. */
  limit: number
  /** Window length in seconds. */
  windowSeconds: number
}

/**
 * Tuned per surface: auth is strict, browsing is generous.
 *
 * A note on the guest-facing limits. Every diner in a restaurant is on the same
 * wifi, so they all share one public IP — an IP-keyed order limit would let the
 * first few tables order and then block the whole room for the rest of the
 * window. `placeOrder` and `serviceRequest` are therefore keyed on the guest
 * session cookie (one phone), with the far looser `*Burst` rules below applied
 * per IP purely as an abuse backstop for someone scripting fresh cookies.
 */
export const RATE_LIMITS = {
  login: { limit: 8, windowSeconds: 300 },
  /*
   * Second-factor codes, per account. Six digits is a million possibilities;
   * five tries in five minutes makes guessing one a non-starter, and a person
   * who mistypes twice still has three left before they wait.
   */
  mfa: { limit: 5, windowSeconds: 300 },
  register: { limit: 5, windowSeconds: 3600 },
  passwordReset: { limit: 5, windowSeconds: 3600 },
  /** per guest device */
  placeOrder: { limit: 12, windowSeconds: 600 },
  /** per venue IP — sized for a full dining room, not one phone */
  placeOrderBurst: { limit: 240, windowSeconds: 600 },
  /** per guest device */
  serviceRequest: { limit: 10, windowSeconds: 300 },
  /** per venue IP */
  serviceRequestBurst: { limit: 200, windowSeconds: 300 },
  /*
   * The checkout summary re-prices on every cart change, so a guest genuinely
   * hits it often — but it is unauthenticated and fans out per distinct dish,
   * and it had no limit at all. Sized per venue IP like its neighbours: roomy
   * for a full dining room editing their carts, closed to a script.
   */
  quoteCartBurst: { limit: 600, windowSeconds: 300 },
  // Also per IP, and also shared by the whole venue: guests browsing the menu
  // and staff devices polling their stations all arrive from one address.
  publicRead: { limit: 600, windowSeconds: 60 },
  mutation: { limit: 300, windowSeconds: 60 },
  upload: { limit: 30, windowSeconds: 300 },
} satisfies Record<string, RateLimitRule>

export type RateLimitName = keyof typeof RATE_LIMITS

/**
 * The caller's address, or null when there is no caller.
 *
 * `headers()` throws outside a request scope. In production that cannot happen
 * — a server action or route handler always has one — but the test suites and
 * the maintenance scripts call services directly, and a rate limiter blowing up
 * a test run is the limiter reporting on its own environment rather than on
 * anything about the request. Null means "not a request", and `rateLimit`
 * treats that as nothing to limit.
 */
export async function clientIp(): Promise<string | null> {
  try {
    const h = await headers()
    return (
      h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      h.get('x-real-ip') ??
      h.get('cf-connecting-ip') ??
      'unknown'
    )
  } catch {
    return null
  }
}

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfterSeconds: number
}

/**
 * Fixed-window rate limit. Backed by Redis when available so the limit is
 * shared across instances; falls back to per-process counters otherwise.
 */
export async function rateLimit(
  name: RateLimitName,
  identifier?: string,
): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[name]
  const id = identifier ?? (await clientIp())

  // No request, no caller, nothing to limit. See `clientIp`.
  if (id === null) {
    return { ok: true, remaining: rule.limit, retryAfterSeconds: 0 }
  }

  /*
   * Identifiers can be attacker-supplied (a login "email" has no practical
   * length cap), and a key past btree's ~2.7KB row limit would fail the
   * shared Postgres tier — quietly demoting that caller to the per-instance
   * fallback, which on serverless is no limit at all. Long ids become their
   * hash: same bucket for the same input, bounded key for any input.
   */
  const bounded = id.length > 120 ? createHash('sha256').update(id).digest('hex') : id
  const key = `rl:${name}:${bounded}`

  const { count, resetAt } = await incrementCounter(key, rule.windowSeconds)
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))

  return {
    ok: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds,
  }
}

/** Throwing variant for server actions and route handlers. */
export async function enforceRateLimit(
  name: RateLimitName,
  identifier?: string,
): Promise<void> {
  const result = await rateLimit(name, identifier)
  if (!result.ok) throw new RateLimitError(result.retryAfterSeconds)
}
