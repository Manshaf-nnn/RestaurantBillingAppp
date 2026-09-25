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
  /*
   * A guest looking up their own points by phone.
   *
   * Tight on purpose. The lookup takes a phone number and no proof, so the
   * only thing stopping somebody walking the number space and reading other
   * people's balances is how often they may ask. A guest checks their own
   * points once or twice a visit.
   */
  /*
   * Sending a test SMS from the settings page.
   *
   * Every press spends one of the owner's own credits against their own
   * gateway, so this is not protecting us — it is stopping a stuck button or
   * an impatient double-click from costing them a handful of messages.
   */
  smsTest: { limit: 5, windowSeconds: 600 },
  loyaltyLookup: { limit: 8, windowSeconds: 600 },
  /** per venue IP — a dining room's worth of guests checking their points */
  loyaltyLookupBurst: { limit: 120, windowSeconds: 600 },
  /*
   * Recognising a returning guest at a delivery checkout: phone in, their own
   * name back, so they do not retype what the restaurant already knows.
   *
   * Tighter than the loyalty lookup because it is the same shape of risk with
   * none of the same excuse — it takes a number and returns a name, which is
   * an enumeration oracle if it is cheap. A real guest types their own number
   * once, maybe twice after a typo; 6 in ten minutes covers that and nothing
   * like a harvest. The burst cap is per venue IP, for a hostel full of people
   * ordering on one wifi.
   */
  guestIdentity: { limit: 6, windowSeconds: 600 },
  guestIdentityBurst: { limit: 90, windowSeconds: 600 },
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
  /*
   * A guest answering a QR menu's entry questions (ar.md §25).
   *
   * Sized like the loyalty lookup it sits beside, and for the same reason: the
   * form takes a phone number and no proof, so the thing stopping somebody
   * walking the number space to find out who eats here is how often they may
   * ask. A real guest submits it once, or twice if they mistype.
   */
  qrEnter: { limit: 10, windowSeconds: 600 },
  /** per venue IP — a dining room's worth of guests arriving at once */
  qrEnterBurst: { limit: 200, windowSeconds: 600 },
  /** Opening a QR menu. Counted once a session, so this is only a floor. */
  qrOpenBurst: { limit: 600, windowSeconds: 300 },
  // Also per IP, and also shared by the whole venue: guests browsing the menu
  // and staff devices polling their stations all arrive from one address.
  publicRead: { limit: 600, windowSeconds: 60 },
  mutation: { limit: 300, windowSeconds: 60 },
  upload: { limit: 30, windowSeconds: 300 },
  /*
   * A restaurant's own website calling in with its key (websiteconnect.md).
   * Keyed on the KEY, not the address: a website is one server at one IP for
   * all of its traffic, so an IP bucket would either be too loose to matter or
   * would stall the whole site the moment it got busy. Reads are roomy — a
   * menu page fetches on every visit — orders are sized for a real evening and
   * closed to a script.
   */
  websiteRead: { limit: 600, windowSeconds: 60 },
  websiteOrder: { limit: 120, windowSeconds: 600 },
  /*
   * A receipt emailed for one order, keyed on the order. Three is one typo
   * and one "send it to my partner too"; unbounded, it was a mail relay to
   * any address from the restaurant's own sending domain, and the first
   * thing it exhausted was the quota password resets depend on.
   */
  emailReceipt: { limit: 3, windowSeconds: 600 },
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
