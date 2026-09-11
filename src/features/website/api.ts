import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'

import { toAppError } from '@/lib/errors'
import { hashToken } from '@/server/auth/password'
import { enforceRateLimit, type RateLimitName } from '@/server/security/rate-limit'
import {
  authenticateWebsiteKey,
  bearerFrom,
  touchWebsiteConnection,
  type WebsiteCaller,
} from './service'

/**
 * The one way into every website route.
 *
 * Rate limit, authenticate, mark the connection live, run the handler, and
 * turn any error into `{ error, code }` with the right status — the same
 * shape every other route in the app answers with. Routes stay ten lines each
 * and cannot forget a step, because the step is not theirs to remember.
 *
 * ── Two limiters, in that order ─────────────────────────────────────────────
 *
 * The per-address cap comes first so a flood of made-up keys is refused
 * before each one costs a lookup. Then the per-key limit, keyed on the hash
 * of whatever was presented — computable before the database is asked, and
 * the same bucket a real website fills as it works.
 */
export async function withWebsiteCaller(
  request: NextRequest,
  limiter: Extract<RateLimitName, 'websiteRead' | 'websiteOrder'>,
  handler: (caller: WebsiteCaller) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    await enforceRateLimit('publicRead')

    const presented = bearerFrom(request.headers.get('authorization'))
    if (presented) await enforceRateLimit(limiter, `website:${hashToken(presented)}`)

    const caller = await authenticateWebsiteKey(presented)
    // Before the handler: the key authenticated, so the website connected —
    // whether or not the request it then made was any good.
    await touchWebsiteConnection(caller.connection)

    return await handler(caller)
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json(
      { error: app.message, code: app.code, ...(app.details ? { details: app.details } : {}) },
      { status: app.status },
    )
  }
}

/** A JSON response no cache in between may keep. */
export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}
