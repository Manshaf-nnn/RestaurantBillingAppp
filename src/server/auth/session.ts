import 'server-only'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import type { Prisma, Session, UserRole } from '@prisma/client'

import { permissionsSoldByFeatures } from '@/features/access/features'
import { guardLocks, prisma } from '@/server/db/prisma'
import { closeShiftForUser, openShift } from '@/features/attendance/service'
import { generateToken, hashToken } from './password'
import { due } from './presence'
import {
  ACCESS_COOKIE_MAX_AGE,
  GUEST_COOKIE,
  GUEST_COOKIE_MAX_AGE,
  REFRESH_COOKIE_MAX_AGE,
  TRANSIENT_SESSION_TTL_SECONDS,
  accessCookieName,
  cookieOptions,
  refreshCookieName,
  refreshGraceSeconds,
  refreshTokenTtlSeconds,
  rotateAfterSeconds,
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
  type SessionScope,
} from './jwt'

/**
 * Sessions: how a signed-in person stays signed in, and how they stop.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 * A short-lived access JWT (15 min) in one httpOnly cookie, and an opaque
 * refresh token — random bytes, stored hashed in `Session` — in another. The
 * access token is verified statelessly at the edge; the refresh token is looked
 * up in the database, which is what makes revocation immediate.
 *
 * ── The race this file used to have ─────────────────────────────────────────
 *
 * Every access-token expiry — every fifteen minutes of use — ROTATED the
 * refresh token: revoke the old row, create a new one. Rotation has one
 * failure mode and this app hit it constantly. Two tabs (a till and a kitchen
 * display, the ordinary shape of a restaurant) both saw the dead access token
 * and both refreshed with the same refresh cookie. The first rotated it and set
 * the new cookie. The second found the row revoked, could not tell that from a
 * stolen or logged-out token, deleted the refresh cookie — the winner's new
 * one, same name — and sent the user to the login screen. A live, unrevoked
 * session sat in this table while they typed their password again.
 *
 * Three things fix it, and all three are in this file:
 *
 *   1. LINEAGE. A row revoked by rotation records `replacedById`. A row revoked
 *      by logout, password reset or suspension does not. So "revoked" now has
 *      two meanings the code can tell apart.
 *   2. GRACE. A token rotated within the last thirty seconds resolves to its
 *      successor instead of failing. The loser of the race gets a working
 *      access token for the session the winner created; the winner's
 *      `Set-Cookie` owns the refresh cookie and is never touched.
 *   3. ROTATE DAILY, NOT EVERY QUARTER HOUR. An expired access token is renewed
 *      from the refresh token WITHOUT rotating it; the refresh token itself
 *      rotates once it is a day old. A stolen token's useful life stays bounded
 *      to a day; the race surface shrinks from ~96 opportunities a day to ~1,
 *      and the grace window covers that one.
 *
 * ── Where cookies can and cannot be written ─────────────────────────────────
 *
 * Next refuses cookie writes during a page RENDER and allows them in route
 * handlers and Server Actions. `renewFromRefreshToken` therefore probes: it
 * writes the new access cookie first, and only if that succeeded does it
 * consider rotating — never revoke in the database what you cannot persist to
 * the browser. A render that cannot write still authenticates the request; the
 * next route-handler poll (`/api/pulse`) does the persisting.
 *
 * The DB logic lives in cookie-free functions (`lookupRefreshSession`,
 * `rotateSessionRecord`, `refreshSession`) so the race can be tested as a race,
 * with `Promise.all`, from a script with no request scope. The exported names
 * callers already use — `createSession`, `rotateSession`,
 * `renewFromRefreshToken`, `destroySession` — are thin cookie-writing wrappers.
 */

/**
 * How often a session's "last used" stamp is allowed to move.
 *
 * Five minutes is finer than anybody reading the Active sessions list needs,
 * and coarse enough that a busy till costs one extra write every five minutes
 * rather than one per tap.
 */
const LAST_USED_EVERY_MS = 5 * 60 * 1000

/**
 * The permission list a custom role contributes, if it is still in force.
 *
 * A deactivated role falls back to the preset defaults rather than to nothing.
 * Returning `[]` here would read as "an explicit empty set" — a person with a
 * blank screen and no way to tell that from a role that genuinely grants
 * nothing. Deactivating a role in the middle of service should demote somebody,
 * not strand them.
 */
function activeRolePermissions(
  staffRole: { permissions: string[]; isActive: boolean } | null | undefined,
): string[] | null {
  if (!staffRole || !staffRole.isActive) return null
  return staffRole.permissions
}

/** Platform admins get an isolated session; everyone else is 'staff'. */
export function scopeForRole(role: UserRole): SessionScope {
  return role === 'SUPER_ADMIN' ? 'admin' : 'staff'
}

export interface AuthUser {
  id: string
  email: string
  name: string
  role: UserRole
  restaurantId: string | null
  /// Home branch, when the restaurant runs more than one location.
  branchId: string | null
  avatarUrl: string | null
  /** Extra keys granted to this person alone. */
  permissions: string[]
  /**
   * The complete list from the restaurant's own role, when they hold one.
   *
   * Null means "no custom role — use the preset defaults". Read fresh from the
   * database on every request rather than carried in the JWT, which is what
   * makes an owner's edit take effect on the member of staff's very next click
   * instead of whenever their token happens to expire.
   */
  rolePermissions: string[] | null
  /**
   * Every permission the platform operator has sold this restaurant.
   *
   * Empty means unrestricted. `permissionsFor` intersects with it, so a feature
   * the tenant has not bought is refused to everybody in it — including the
   * owner.
   */
  availablePermissions: string[]
  sessionId: string
}

export interface RequestContext {
  ipAddress: string | null
  userAgent: string | null
}

export async function requestContext(): Promise<RequestContext> {
  const h = await headers()
  const forwarded = h.get('x-forwarded-for')
  return {
    ipAddress: forwarded?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
  }
}

/** Everything about the user a session needs to resolve, in one select. */
const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  restaurantId: true,
  branchId: true,
  avatarUrl: true,
  permissions: true,
  isActive: true,
  deletedAt: true,
  staffRole: { select: { permissions: true, isActive: true } },
  /*
   * What the platform operator has sold this restaurant.
   *
   * On the query that was already loading the session, so the feature gate
   * costs no extra round trip on any request.
   */
  restaurant: { select: { enabledFeatures: true } },
} satisfies Prisma.UserSelect

type SessionUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>
type SessionWithUser = Session & { user: SessionUser }

function toAuthUser(user: SessionUser, sessionId: string): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    restaurantId: user.restaurantId,
    branchId: user.branchId ?? null,
    avatarUrl: user.avatarUrl,
    permissions: user.permissions,
    rolePermissions: activeRolePermissions(user.staffRole),
    /*
     * Expanded once, here, rather than wherever a permission is checked.
     *
     * Empty stays empty: `permissionsFor` reads that as "unrestricted", which
     * is what every restaurant that has never been scoped should get.
     */
    availablePermissions: permissionsSoldByFeatures(user.restaurant?.enabledFeatures ?? []),
    sessionId,
  }
}

function claimsFor(user: SessionUser, sessionId: string): AccessClaims {
  return {
    sub: user.id,
    rid: user.restaurantId,
    role: user.role,
    name: user.name,
    email: user.email,
    sid: sessionId,
  }
}

const ageSeconds = (since: Date, now: Date) => (now.getTime() - since.getTime()) / 1000

// ── Creating ─────────────────────────────────────────────────────────────────

/**
 * Issues a fresh session: a random opaque refresh token (stored hashed) plus a
 * short-lived access JWT. Both are set as httpOnly cookies.
 *
 * `persistent` is the "Remember me" box, which for a long time was parsed by the
 * schema and read by nothing — a control that did nothing, which is worse than
 * no control. Unticked now means a twelve-hour session (a shift, not a month)
 * whose refresh cookie carries no Max-Age, so the browser drops it when it
 * closes. Ticked means the full scope lifetime, as before.
 */
export async function createSession(
  userId: string,
  options: { persistent?: boolean } = {},
): Promise<{ accessToken: string }> {
  const persistent = options.persistent ?? true

  const user = await prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT })
  if (!user) throw new Error('Cannot create a session for a user that does not exist')

  // Platform admins land in the 'admin' cookie namespace; everyone else 'staff'.
  const scope = scopeForRole(user.role)
  const ctx = await requestContext()
  const refreshToken = generateToken()
  const ttlSeconds = persistent ? refreshTokenTtlSeconds(scope) : TRANSIENT_SESSION_TTL_SECONDS

  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: ctx.userAgent?.slice(0, 500),
      ipAddress: ctx.ipAddress,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    },
  })

  const accessToken = await signAccessToken(claimsFor(user, session.id))

  const store = await cookies()
  store.set(accessCookieName(scope), accessToken, cookieOptions(ACCESS_COOKIE_MAX_AGE()))
  store.set(
    refreshCookieName(scope),
    refreshToken,
    // No Max-Age for a transient session: a browser-session cookie, gone when
    // the browser closes. The twelve-hour row is the real bound either way.
    cookieOptions(persistent ? REFRESH_COOKIE_MAX_AGE(scope) : undefined),
  )

  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null },
  })

  /*
   * Signing in is clocking in.
   *
   * Every way into this application ends here — password, staff code (which is
   * a password: `issueSignInCode` writes it into `passwordHash`), a personal
   * access link, a shared-device link — so one call covers them all, and a new
   * sign-in route added later is covered by construction rather than by
   * somebody remembering.
   *
   * Awaited, because the shift must exist before the first action can stamp it,
   * but never allowed to fail a login: attendance is a record of work, not a
   * precondition for it. `openShift` itself declines to record shared screens
   * and platform operators.
   */
  await openShift(userId).catch((error) => {
    console.error('[attendance] could not open a shift', error)
  })

  return { accessToken }
}

// ── The cookie-free core ─────────────────────────────────────────────────────

export type RefusalReason =
  | 'unknown'
  | 'revoked'
  | 'reused'
  | 'successor-gone'
  | 'expired'
  | 'inactive'
  | 'scope'

export type LookupOutcome =
  /** The token names a live session. */
  | { kind: 'live'; session: SessionWithUser }
  /**
   * The token was rotated within the grace window and its successor is live.
   * `session` is the successor — the one the caller should mint for.
   */
  | { kind: 'superseded'; session: SessionWithUser; predecessorId: string }
  | { kind: 'refused'; reason: RefusalReason }

/**
 * What a refresh token currently means. The single source of truth for both
 * the refresh endpoint and the in-request renewal.
 *
 * `now` is a parameter so a test can reason about the clock without a mock;
 * production callers omit it.
 */
export async function lookupRefreshSession(
  rawRefreshToken: string,
  scope: SessionScope,
  now: Date = new Date(),
): Promise<LookupOutcome> {
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashToken(rawRefreshToken) },
    include: { user: { select: USER_SELECT } },
  })
  if (!session) return { kind: 'refused', reason: 'unknown' }
  if (!session.user.isActive || session.user.deletedAt) return { kind: 'refused', reason: 'inactive' }
  // The refresh token must belong to the scope it's being used for.
  if (scopeForRole(session.user.role) !== scope) return { kind: 'refused', reason: 'scope' }

  if (session.revokedAt) {
    /*
     * Revoked WITHOUT a successor is a real revocation — logout, password
     * reset, suspension, deactivation. Nothing to follow; refuse.
     */
    if (!session.replacedById) return { kind: 'refused', reason: 'revoked' }

    /*
     * Revoked BY ROTATION. Inside the grace window this is the loser of the
     * race that used to log people out: a sibling request rotated the token a
     * moment ago and this one arrived with the old value. Hand it the
     * successor.
     *
     * Outside the window it is a replay of a token that has been dead for a
     * while — the OAuth working group calls this reuse detection. Refused, and
     * recorded, because a legitimate client has no reason to present a token
     * more than thirty seconds after it was rotated. Recorded rather than acted
     * on (revoking the whole lineage) for one release, so the real rate of
     * legitimate hits is known before it becomes a reason to sign anyone out.
     */
    if (ageSeconds(session.revokedAt, now) > refreshGraceSeconds()) {
      // Awaited: a refusal is not a hot path, and a record that may or may not
      // have been written by the time the response leaves is not a record. A
      // failure to write is logged, not thrown — the refusal stands regardless.
      await prisma.auditLog
        .create({
          data: {
            restaurantId: session.user.restaurantId,
            userId: session.userId,
            // AUDIT_ACTIONS.SESSION_REUSE_DETECTED — written as a literal
            // because audit.ts imports requestContext from this file.
            action: 'auth.session_reuse_detected',
            entity: 'Session',
            entityId: session.id,
            after: { replacedById: session.replacedById, revokedAt: session.revokedAt },
          },
        })
        .catch((error: unknown) => {
          console.error('[auth] could not record session reuse', error)
        })
      return { kind: 'refused', reason: 'reused' }
    }

    /*
     * One hop, asserted — not a chain. A successor is under a day old by
     * construction and the grace path never rotates, so a legitimate client can
     * never be two rotations behind inside thirty seconds. Requiring the
     * successor to be LIVE is what stops a predecessor token outliving a
     * logout: rotate, then sign out within the window, and the old token must
     * still be refused.
     */
    const successor = await prisma.session.findUnique({
      where: { id: session.replacedById },
      include: { user: { select: USER_SELECT } },
    })
    if (!successor || successor.revokedAt || successor.expiresAt <= now) {
      return { kind: 'refused', reason: 'successor-gone' }
    }
    return { kind: 'superseded', session: successor, predecessorId: session.id }
  }

  if (session.expiresAt <= now) return { kind: 'refused', reason: 'expired' }
  return { kind: 'live', session }
}

/** Thrown inside the rotation transaction when the compare-and-swap loses. */
class RotationLost extends Error {
  constructor() {
    super('rotation lost to a concurrent refresh')
  }
}

/**
 * Replace one refresh token with a new one — atomically, or not at all.
 *
 * ── Why this is a transaction and a compare-and-swap ────────────────────────
 *
 * The old `rotateSession` did `update({ where: { id } })` — keyed by id alone,
 * with no guard on `revokedAt`. Two concurrent callers could both read the row
 * as live, both revoke it, both create successors, and race two `Set-Cookie`
 * headers into one cookie jar. The `updateMany` below matches only a row that
 * is STILL unrevoked; Postgres serialises the two updates on the row lock and
 * re-evaluates the predicate against the committed version, so exactly one
 * caller matches. The other matches zero rows, throws, and the transaction
 * rolls back the successor it had just created — no orphan, no dangling
 * `replacedById`.
 *
 * The successor is created FIRST so its id can be written onto the predecessor
 * in the same statement that revokes it. A crash between the two statements
 * would otherwise leave a revoked row pointing at nothing, and a grace-window
 * loser with no successor to follow.
 *
 * Two statements, milliseconds, well inside Netlify's ten-second budget and
 * PgBouncer's transaction mode. `guardLocks` per the house pattern.
 */
export async function rotateSessionRecord(params: {
  predecessor: Session
  scope: SessionScope
  ctx: RequestContext
  now?: Date
}): Promise<{ successor: Session; refreshToken: string } | null> {
  const now = params.now ?? new Date()
  const refreshToken = generateToken()

  try {
    const successor = await prisma.$transaction(async (tx) => {
      await guardLocks(tx)
      const created = await tx.session.create({
        data: {
          userId: params.predecessor.userId,
          refreshTokenHash: hashToken(refreshToken),
          userAgent: params.ctx.userAgent?.slice(0, 500),
          ipAddress: params.ctx.ipAddress,
          expiresAt: new Date(now.getTime() + refreshTokenTtlSeconds(params.scope) * 1000),
        },
      })
      const { count } = await tx.session.updateMany({
        where: { id: params.predecessor.id, revokedAt: null },
        data: { revokedAt: now, replacedById: created.id },
      })
      if (count === 0) throw new RotationLost()
      return created
    })
    return { successor, refreshToken }
  } catch (error) {
    if (error instanceof RotationLost) return null
    throw error
  }
}

export type RefreshResult =
  | { outcome: 'renewed'; sessionId: string; accessToken: string; user: AuthUser }
  | { outcome: 'rotated'; sessionId: string; accessToken: string; refreshToken: string; user: AuthUser }
  | { outcome: 'superseded'; sessionId: string; accessToken: string; user: AuthUser }
  | { outcome: 'refused'; reason: RefusalReason }

/**
 * Turn a refresh token into a fresh access token, rotating the refresh token
 * when it is due. Cookie-free: this is the whole decision, and the wrappers
 * below only persist what it returns.
 *
 * `allowRotation: false` is for callers that cannot promise to persist a new
 * refresh cookie (a page render) — they renew access only and leave rotation to
 * a later request that can.
 */
export async function refreshSession(
  rawRefreshToken: string,
  scope: SessionScope,
  options: { ctx: RequestContext; now?: Date; allowRotation?: boolean },
): Promise<RefreshResult> {
  const now = options.now ?? new Date()
  const found = await lookupRefreshSession(rawRefreshToken, scope, now)
  if (found.kind === 'refused') return { outcome: 'refused', reason: found.reason }

  if (found.kind === 'superseded') {
    const accessToken = await signAccessToken(claimsFor(found.session.user, found.session.id))
    return {
      outcome: 'superseded',
      sessionId: found.session.id,
      accessToken,
      user: toAuthUser(found.session.user, found.session.id),
    }
  }

  const { session } = found
  const due = (options.allowRotation ?? true) && ageSeconds(session.createdAt, now) >= rotateAfterSeconds()

  if (due) {
    const rotated = await rotateSessionRecord({ predecessor: session, scope, ctx: options.ctx, now })
    if (rotated) {
      const accessToken = await signAccessToken(claimsFor(session.user, rotated.successor.id))
      return {
        outcome: 'rotated',
        sessionId: rotated.successor.id,
        accessToken,
        refreshToken: rotated.refreshToken,
        user: toAuthUser(session.user, rotated.successor.id),
      }
    }
    /*
     * Lost the compare-and-swap: a sibling rotated this token between our read
     * and our write. Its `Set-Cookie` owns the refresh cookie now. Look the
     * token up again — it is revoked-with-successor, milliseconds old — and
     * take the superseded path, exactly as if we had arrived late.
     */
    const again = await lookupRefreshSession(rawRefreshToken, scope, new Date())
    if (again.kind === 'refused') return { outcome: 'refused', reason: again.reason }
    // `live` here would mean the sibling's rotation rolled back between our two
    // reads; minting for whichever row is live is correct in either case.
    const accessToken = await signAccessToken(claimsFor(again.session.user, again.session.id))
    return {
      outcome: 'superseded',
      sessionId: again.session.id,
      accessToken,
      user: toAuthUser(again.session.user, again.session.id),
    }
  }

  const accessToken = await signAccessToken(claimsFor(session.user, session.id))
  return {
    outcome: 'renewed',
    sessionId: session.id,
    accessToken,
    user: toAuthUser(session.user, session.id),
  }
}

// ── The cookie-writing wrappers ──────────────────────────────────────────────

type CookieStore = Awaited<ReturnType<typeof cookies>>

function clearSessionCookies(store: CookieStore, scope: SessionScope) {
  store.delete(accessCookieName(scope))
  store.delete(refreshCookieName(scope))
}

/**
 * The refresh endpoint's entry point: renew, rotate if due, and persist.
 *
 * Name kept for its callers. Returns null ONLY on a real refusal, and clears
 * the cookies itself in that case — the route used to do that, and used to do
 * it for the race loser too, which is how a valid session got its cookie
 * deleted. A `superseded` result is a success: the access cookie is set for the
 * successor and the refresh cookie is deliberately left alone, because the
 * winner's response already set it.
 */
export async function rotateSession(
  rawRefreshToken: string,
  scope: SessionScope = 'staff',
): Promise<AuthUser | null> {
  const store = await cookies()
  const ctx = await requestContext()
  const result = await refreshSession(rawRefreshToken, scope, { ctx, allowRotation: true })

  if (result.outcome === 'refused') {
    clearSessionCookies(store, scope)
    return null
  }

  store.set(accessCookieName(scope), result.accessToken, cookieOptions(ACCESS_COOKIE_MAX_AGE()))
  if (result.outcome === 'rotated') {
    // A transient ("remember me" off) session can never be rotated — its
    // twelve-hour life is shorter than the rotation threshold, asserted at
    // module load in jwt.ts — so a rotated cookie always carries the full
    // scope lifetime.
    store.set(refreshCookieName(scope), result.refreshToken, cookieOptions(REFRESH_COOKIE_MAX_AGE(scope)))
  }
  return result.user
}

export async function destroySession(scope: SessionScope = 'staff'): Promise<void> {
  const store = await cookies()
  const raw = store.get(refreshCookieName(scope))?.value
  if (raw) {
    const live = await prisma.session
      .findFirst({
        where: { refreshTokenHash: hashToken(raw), revokedAt: null },
        select: { userId: true },
      })
      .catch(() => null)

    /*
     * A logout revokes WITHOUT `replacedById`: there is no successor to follow,
     * so a refresh with this token afterwards is refused outright. That is the
     * distinction lineage exists to make.
     */
    await prisma.session
      .updateMany({
        where: { refreshTokenHash: hashToken(raw), revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => undefined)

    /*
     * Signing out ends the shift — at the last thing they DID, which
     * `closeShiftForUser` handles, not at this click. Somebody who finishes at
     * ten and signs out at eleven worked until ten.
     *
     * Here and not in `revokeAllSessions`: that one fires on a password change
     * and on "sign out everywhere else", neither of which means the person has
     * gone home. Nor in rotation, which is routine — once a day now, and it
     * would clock everybody out at the moment their token happened to turn over.
     */
    if (live?.userId) {
      await closeShiftForUser(live.userId).catch((error) => {
        console.error('[attendance] could not close a shift', error)
      })
    }
  }
  clearSessionCookies(store, scope)
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  })
  return result.count
}

/**
 * Renew an expired access token from the refresh cookie, mid-request.
 *
 * ── Probe, then rotate ──────────────────────────────────────────────────────
 *
 * This runs during page renders and Server Actions, and Next forbids writing
 * cookies during a render. So the new access cookie is written FIRST, inside a
 * try. If that throws we are rendering: the request is still authenticated,
 * nothing is persisted, nothing is rotated, and the next route-handler poll
 * (`/api/pulse`) will persist for us. If it succeeds we are somewhere cookies
 * stick — and only then, if the refresh token is a day old, do we rotate it.
 *
 * Rotating here matters more than it looks. The polling screens keep the
 * access cookie alive through this exact path, so a kitchen display that never
 * navigates would never reach the redirect-driven refresh endpoint — and would
 * be logged out the instant its thirty-day row expired, at a random moment
 * mid-service. Rotating wherever a cookie can be written is what makes the
 * thirty days slide for a station that is used every day.
 *
 * This is also what closes the window where the JWT had expired but its cookie
 * had not, in which every Server Action used to fail.
 */
async function renewFromRefreshToken(scope: SessionScope): Promise<AuthUser | null> {
  const store = await cookies()
  const raw = store.get(refreshCookieName(scope))?.value
  if (!raw) return null

  const now = new Date()
  const found = await lookupRefreshSession(raw, scope, now)
  if (found.kind === 'refused') return null

  const { session } = found
  let accessToken = await signAccessToken(claimsFor(session.user, session.id))

  let persisted = true
  try {
    store.set(accessCookieName(scope), accessToken, cookieOptions(ACCESS_COOKIE_MAX_AGE()))
  } catch {
    // Rendering a page — Next refuses cookie writes there. The user is still
    // authenticated for this request; only the saving of the new token is lost.
    persisted = false
  }

  const rotationDue =
    persisted && found.kind === 'live' && ageSeconds(session.createdAt, now) >= rotateAfterSeconds()

  if (rotationDue) {
    const ctx = await requestContext().catch(() => ({ ipAddress: null, userAgent: null }))
    const rotated = await rotateSessionRecord({ predecessor: session, scope, ctx, now })
    if (rotated) {
      accessToken = await signAccessToken(claimsFor(session.user, rotated.successor.id))
      // The first write succeeded, so these cannot throw; the try is belt and braces.
      try {
        store.set(accessCookieName(scope), accessToken, cookieOptions(ACCESS_COOKIE_MAX_AGE()))
        store.set(
          refreshCookieName(scope),
          rotated.refreshToken,
          cookieOptions(REFRESH_COOKIE_MAX_AGE(scope)),
        )
      } catch {
        // Unreachable in practice; documented above.
      }
      return toAuthUser(session.user, rotated.successor.id)
    }
    // Lost the compare-and-swap to a sibling. Its Set-Cookie owns the refresh
    // cookie; follow the lineage it just wrote and mint for the successor.
    const again = await lookupRefreshSession(raw, scope, new Date())
    if (again.kind !== 'superseded' && again.kind !== 'live') return null
    accessToken = await signAccessToken(claimsFor(again.session.user, again.session.id))
    try {
      store.set(accessCookieName(scope), accessToken, cookieOptions(ACCESS_COOKIE_MAX_AGE()))
    } catch {
      // As above.
    }
    return toAuthUser(again.session.user, again.session.id)
  }

  return toAuthUser(session.user, session.id)
}

async function resolveUser(scope: SessionScope): Promise<AuthUser | null> {
  const store = await cookies()
  const token = store.get(accessCookieName(scope))?.value

  // Expired or absent access token, but the session behind it may still be
  // live. Falling straight through to null here is what used to strand a
  // Server Action mid-click.
  const claims = token ? await verifyAccessToken(token) : null
  if (!claims?.sub || !claims.sid) return renewFromRefreshToken(scope)

  const session = await prisma.session.findFirst({
    where: { id: claims.sid, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, user: { select: USER_SELECT } },
  })

  // The session the token names is gone — usually because a concurrent refresh
  // rotated it. The refresh cookie will name the live one, so try that before
  // declaring the visitor signed out.
  if (!session) return renewFromRefreshToken(scope)
  if (!session.user.isActive || session.user.deletedAt) return null
  // A token from the wrong namespace (e.g. an admin token used as staff) is
  // rejected — the scope and the user's role must agree.
  if (scopeForRole(session.user.role) !== scope) return null

  /*
   * "Last used" is now actually last used.
   *
   * `Session.lastUsedAt` has existed since the beginning, is selected by
   * `listSessions`, and is rendered on the profile page under a device's IP as
   * the time it was last active — and nothing has ever written it. It defaults
   * to `now()` at creation and never moves, so the Active sessions panel has
   * been showing sign-in time labelled as last-used time. Somebody deciding
   * whether a session they do not recognise is stale was reading a number that
   * could not tell them.
   *
   * Here rather than in rotation: rotation inserts a NEW row and revokes the
   * old one, so writing it there would leave the row anybody is actually
   * looking at frozen for ever.
   *
   * Throttled, and deliberately not awaited. This runs on every guarded render
   * and every Server Action; a write per request would be absurd for a column
   * read by one settings screen, and a failure here must never cost somebody
   * their page.
   */
  if (due(`session:${session.id}`, LAST_USED_EVERY_MS)) {
    prisma.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {})
  }

  return toAuthUser(session.user, session.id)
}

/**
 * The signed-in staff / restaurant user (dashboard, kitchen, cashier, …).
 *
 * Memoised per request. Almost every render resolves the session at least
 * twice — the layout guards, then the page guards again — and each call was a
 * cookie read, a JWT verify and a session-plus-user query. On a Server Action
 * that revalidates, the page is re-rendered inside the same POST, so it ran
 * four times for one click. `React.cache` collapses that to one, which matters
 * most on exactly the requests that were closest to the serverless time limit.
 *
 * Safe to cache: the cache is per-request, and the only thing that changes the
 * answer mid-request is `renewFromRefreshToken` issuing a new access token —
 * which returns the same user either way. It also means the rotation inside
 * `renewFromRefreshToken` runs at most once per request.
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  return resolveUser('staff')
})

/** The signed-in platform admin — a completely separate session from staff. */
export const getAdminUser = cache(async (): Promise<AuthUser | null> => {
  return resolveUser('admin')
})

/** Stable anonymous identifier for QR guests, so they can track their orders. */
export async function getOrCreateGuestSessionId(): Promise<string> {
  const store = await cookies()
  const existing = store.get(GUEST_COOKIE)?.value
  if (existing) return existing

  const id = generateToken(18)
  store.set(GUEST_COOKIE, id, {
    ...cookieOptions(GUEST_COOKIE_MAX_AGE),
    httpOnly: false, // read by the client cart to reconcile local state
  })
  return id
}

export async function getGuestSessionId(): Promise<string | null> {
  const store = await cookies()
  return store.get(GUEST_COOKIE)?.value ?? null
}
