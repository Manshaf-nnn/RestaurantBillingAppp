import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import type { UserRole } from '@prisma/client'

/**
 * JWT issuing / verification, and the session lifetimes.
 *
 * Uses `jose` so the same code runs in the Node runtime (route handlers,
 * server actions) and the Edge runtime (middleware).
 *
 * ── The two tokens, and why only one of them is a JWT ───────────────────────
 *
 * The ACCESS token is a short-lived signed JWT: verifiable at the edge with no
 * database, carrying just enough (`sub`, `rid`, `role`, `sid`) for middleware to
 * route. The REFRESH token is an opaque random string stored hashed in
 * `Session.refreshTokenHash` — it has to be revocable instantly, which a
 * self-contained JWT cannot be. (`signRefreshToken`/`verifyRefreshToken` used
 * to live here as dead code from before that decision; they are gone.)
 */

// Staff / restaurant sessions.
export const ACCESS_COOKIE = 'ros_at'
export const REFRESH_COOKIE = 'ros_rt'

// Platform-admin sessions use a SEPARATE cookie namespace so an admin and a
// restaurant owner can be signed in at the same time in the same browser
// (admin in one tab, a dashboard in another) without clobbering each other.
export const ADMIN_ACCESS_COOKIE = 'ros_admin_at'
export const ADMIN_REFRESH_COOKIE = 'ros_admin_rt'

export const GUEST_COOKIE = 'ros_gs'

export type SessionScope = 'staff' | 'admin'

export function accessCookieName(scope: SessionScope) {
  return scope === 'admin' ? ADMIN_ACCESS_COOKIE : ACCESS_COOKIE
}

export function refreshCookieName(scope: SessionScope) {
  return scope === 'admin' ? ADMIN_REFRESH_COOKIE : REFRESH_COOKIE
}

const ISSUER = 'restaurantos'
const AUDIENCE = 'restaurantos.app'

/** Custom claims carried by the access token, on top of the registered ones. */
export interface AccessClaims {
  sub: string
  rid: string | null
  role: UserRole
  name: string
  email: string
  sid: string
}

export type AccessTokenClaims = JWTPayload & AccessClaims

function secret(name: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'): Uint8Array {
  const value = process.env[name]
  if (!value || value.length < 32) {
    throw new Error(`${name} is missing or shorter than 32 characters`)
  }
  return new TextEncoder().encode(value)
}

// ── Lifetimes ────────────────────────────────────────────────────────────────

export function accessTokenTtl(): string {
  return process.env.ACCESS_TOKEN_TTL || '15m'
}

/**
 * `ACCESS_TOKEN_TTL` as a number of seconds, for the cookie's Max-Age.
 *
 * Accepts the same shorthand `jose` does — `15m`, `1h`, `900s`, `2d`. Anything
 * it cannot read falls back to fifteen minutes rather than to a broken cookie.
 */
export function accessTokenTtlSeconds(): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(accessTokenTtl().trim())
  if (!match) return 15 * 60
  const n = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  const factor = unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1
  return n * factor
}

/** Staff refresh lifetime in days. Env `REFRESH_TOKEN_TTL_DAYS`, default 30. */
export function refreshTokenTtlDays(): number {
  const parsed = Number(process.env.REFRESH_TOKEN_TTL_DAYS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30
}

/**
 * How long a refresh session lives, by scope.
 *
 * Staff: 30 days, sliding — rotation (below) creates a fresh row with a fresh
 * expiry roughly once a day of active use, so a till that is used every day
 * never sees a login screen.
 *
 * Admin: 12 hours, ABSOLUTE. That is shorter than the rotation threshold, so an
 * admin session is never rotated and never slides; the platform operator
 * re-authenticates every day. The account can reach every tenant, and a
 * credential that can do that should not be able to live for a month on the
 * strength of one password entry. This is the "stronger controls for super
 * admin" the spec asks for, together with the MFA step-up at login.
 */
export function refreshTokenTtlSeconds(scope: SessionScope): number {
  if (scope === 'admin') {
    const hours = Number(process.env.ADMIN_REFRESH_TOKEN_TTL_HOURS)
    return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600
  }
  return refreshTokenTtlDays() * 86_400
}

/**
 * How old a refresh token must be before a refresh ROTATES it.
 *
 * Rotation used to happen on every access-token expiry — every fifteen minutes
 * of use — and rotation is where the race lived: two tabs refreshing at once,
 * the loser finding a revoked row and deleting the winner's new cookie. Rotating
 * once a day keeps a stolen token's useful life bounded to a day while cutting
 * the race surface from ~96 opportunities a day to ~1, and the grace window in
 * `session.ts` handles that one.
 */
export function rotateAfterSeconds(): number {
  const hours = Number(process.env.REFRESH_ROTATE_AFTER_HOURS)
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600
}

/**
 * How long after a rotation the OLD token still resolves to its successor.
 *
 * Long enough to cover a sibling request that was already in flight when the
 * winner rotated; short enough that a token stolen yesterday is refused today.
 */
export function refreshGraceSeconds(): number {
  const seconds = Number(process.env.REFRESH_GRACE_SECONDS)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 30
}

/**
 * Lifetime of a session created with "Remember me" UNTICKED.
 *
 * Twelve hours: a shift, not a month. Deliberately shorter than
 * `rotateAfterSeconds()` — a transient session can then never be rotated, so
 * nothing has to remember that it was transient, and no column is needed. The
 * assertion below makes that invariant fail at module load if an env override
 * ever breaks it, rather than quietly turning a shift into a month.
 */
export const TRANSIENT_SESSION_TTL_SECONDS = 12 * 3_600

if (TRANSIENT_SESSION_TTL_SECONDS >= rotateAfterSeconds()) {
  throw new Error(
    `REFRESH_ROTATE_AFTER_HOURS (${rotateAfterSeconds() / 3_600}h) must exceed the ` +
      `transient-session lifetime (${TRANSIENT_SESSION_TTL_SECONDS / 3_600}h), or a ` +
      '"remember me: off" session could be rotated into a long-lived one.',
  )
}

// ── Signing / verifying ──────────────────────────────────────────────────────

/**
 * Sign an access token.
 *
 * `opts.ttl` exists for the tests: minting a token that is ALREADY expired is
 * how the runtime suite proves the refresh path recovers a real session rather
 * than a garbage cookie. `jose` accepts negative durations (`'-1m'`) and
 * `jwtVerify` refuses the result as `JWTExpired`, so an expired test token is
 * genuinely expired. Production callers never pass it.
 */
export async function signAccessToken(
  claims: AccessClaims,
  opts: { ttl?: string } = {},
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(opts.ttl ?? accessTokenTtl())
    .sign(secret('JWT_ACCESS_SECRET'))
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret('JWT_ACCESS_SECRET'), {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    return payload as AccessTokenClaims
  } catch {
    return null
  }
}

// ── Cookies ──────────────────────────────────────────────────────────────────

/**
 * `Secure` must track the *transport*, not `NODE_ENV`. A Secure cookie is
 * dropped by some browsers (Safari) over plain HTTP, which would let login
 * "succeed" server-side while the browser never stores the session. So we mark
 * cookies Secure only when the site is actually served over HTTPS.
 *
 * With one safety net: a production build whose host injects NO public URL at
 * all (`NEXT_PUBLIC_APP_URL`, Netlify's `URL`, Render's `RENDER_EXTERNAL_URL`)
 * is still a production site, and a production site is served over HTTPS. The
 * previous rule resolved that case to `''.startsWith('https://')` — false — and
 * issued session cookies without Secure on an HTTPS site.
 *
 * `maxAge` is optional so a "remember me: off" refresh cookie can be a browser-
 * session cookie — one the browser drops when it closes. Every other cookie
 * passes a lifetime.
 */
export function cookieOptions(maxAgeSeconds?: number) {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL || process.env.URL || process.env.RENDER_EXTERNAL_URL || ''
  return {
    httpOnly: true,
    secure:
      appUrl.startsWith('https://') || (process.env.NODE_ENV === 'production' && !appUrl),
    sameSite: 'lax' as const,
    path: '/',
    ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
  }
}

/**
 * The access cookie lives exactly as long as the JWT inside it.
 *
 * DELIBERATE behaviour change 2026-09-05: this was `60 * 60`, four times the
 * fifteen-minute token, under a comment saying it "slightly exceeds" it. For
 * forty-five minutes of every hour the browser therefore presented a cookie
 * whose JWT was dead — a verify that could only fail, followed by a redirect —
 * and that redirect was the path the rotation race lived on. A cookie that
 * outlives its token buys nothing; one that expires with it means an absent
 * cookie and a dead token are the same case, handled the same way.
 */
export const ACCESS_COOKIE_MAX_AGE = () => accessTokenTtlSeconds()
export const REFRESH_COOKIE_MAX_AGE = (scope: SessionScope) => refreshTokenTtlSeconds(scope)
export const GUEST_COOKIE_MAX_AGE = 60 * 60 * 12
