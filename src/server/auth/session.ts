import 'server-only'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import type { UserRole } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { generateToken, hashToken } from './password'
import {
  ACCESS_COOKIE_MAX_AGE,
  GUEST_COOKIE,
  GUEST_COOKIE_MAX_AGE,
  REFRESH_COOKIE_MAX_AGE,
  accessCookieName,
  cookieOptions,
  refreshCookieName,
  refreshTokenTtlDays,
  signAccessToken,
  verifyAccessToken,
  type SessionScope,
} from './jwt'

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

/**
 * Issues a fresh session: a random opaque refresh token (stored hashed) plus a
 * short-lived access JWT. Both are set as httpOnly cookies.
 */
export async function createSession(userId: string): Promise<{ accessToken: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error('Cannot create a session for a user that does not exist')

  // Platform admins land in the 'admin' cookie namespace; everyone else 'staff'.
  const scope = scopeForRole(user.role)
  const ctx = await requestContext()
  const refreshToken = generateToken()

  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: ctx.userAgent?.slice(0, 500),
      ipAddress: ctx.ipAddress,
      expiresAt: new Date(Date.now() + refreshTokenTtlDays() * 24 * 60 * 60 * 1000),
    },
  })

  const accessToken = await signAccessToken({
    sub: user.id,
    rid: user.restaurantId,
    role: user.role,
    name: user.name,
    email: user.email,
    sid: session.id,
  })

  const store = await cookies()
  store.set(accessCookieName(scope), accessToken, cookieOptions(ACCESS_COOKIE_MAX_AGE))
  store.set(refreshCookieName(scope), refreshToken, cookieOptions(REFRESH_COOKIE_MAX_AGE()))

  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null },
  })

  return { accessToken }
}

/**
 * Rotates a refresh token. The old token is revoked and a brand new one issued,
 * so a stolen token is usable at most once before the legitimate client's next
 * refresh invalidates it.
 */
export async function rotateSession(
  rawRefreshToken: string,
  scope: SessionScope = 'staff',
): Promise<AuthUser | null> {
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashToken(rawRefreshToken) },
    include: {
      user: {
        select: {
          id: true, email: true, name: true, role: true, restaurantId: true,
          branchId: true, avatarUrl: true, permissions: true, isActive: true,
          deletedAt: true,
          staffRole: { select: { permissions: true, isActive: true } },
        },
      },
    },
  })

  if (!session || session.revokedAt || session.expiresAt < new Date()) return null
  if (!session.user.isActive || session.user.deletedAt) return null
  // The refresh token must belong to the scope it's being used for.
  if (scopeForRole(session.user.role) !== scope) return null

  const ctx = await requestContext()
  const nextToken = generateToken()

  const [, updated] = await prisma.$transaction([
    prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    }),
    prisma.session.create({
      data: {
        userId: session.userId,
        refreshTokenHash: hashToken(nextToken),
        userAgent: ctx.userAgent?.slice(0, 500),
        ipAddress: ctx.ipAddress,
        expiresAt: new Date(Date.now() + refreshTokenTtlDays() * 24 * 60 * 60 * 1000),
      },
    }),
  ])

  const user = session.user
  const accessToken = await signAccessToken({
    sub: user.id,
    rid: user.restaurantId,
    role: user.role,
    name: user.name,
    email: user.email,
    sid: updated.id,
  })

  const store = await cookies()
  store.set(accessCookieName(scope), accessToken, cookieOptions(ACCESS_COOKIE_MAX_AGE))
  store.set(refreshCookieName(scope), nextToken, cookieOptions(REFRESH_COOKIE_MAX_AGE()))

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
    sessionId: updated.id,
  }
}

export async function destroySession(scope: SessionScope = 'staff'): Promise<void> {
  const store = await cookies()
  const raw = store.get(refreshCookieName(scope))?.value
  if (raw) {
    await prisma.session
      .updateMany({
        where: { refreshTokenHash: hashToken(raw), revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => undefined)
  }
  store.delete(accessCookieName(scope))
  store.delete(refreshCookieName(scope))
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
 * Resolves the signed-in user for the current request.
 *
 * Reads the access JWT, then confirms the backing session row is still live —
 * so revoking a session takes effect immediately rather than after the JWT
 * expires.
 */
/**
 * Mint a replacement access token from a still-valid refresh token.
 *
 * Deliberately NOT `rotateSession`. That one revokes the old refresh token and
 * issues a new one, which is correct for the refresh endpoint but unsafe here:
 * this runs during page renders and Server Actions, and Next forbids writing
 * cookies during a render. A rotation whose cookie write is refused would
 * revoke the session in the database while the browser kept the dead token —
 * signing the user out for good.
 *
 * Issuing only a new access token has no such failure mode. The refresh token
 * is read, never changed, so a refused cookie write costs nothing: the next
 * request simply tries again, and navigations still get full rotation via
 * /api/auth/refresh.
 *
 * This is what closes the 45-minute window where the 15-minute JWT had expired
 * but its 60-minute cookie had not — the window in which every Server Action
 * failed.
 */
async function renewFromRefreshToken(scope: SessionScope): Promise<AuthUser | null> {
  const store = await cookies()
  const refreshToken = store.get(refreshCookieName(scope))?.value
  if (!refreshToken) return null

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashToken(refreshToken) },
    include: {
      user: {
        select: {
          id: true, email: true, name: true, role: true, restaurantId: true,
          branchId: true, avatarUrl: true, permissions: true, isActive: true,
          deletedAt: true,
          staffRole: { select: { permissions: true, isActive: true } },
        },
      },
    },
  })

  if (!session || session.revokedAt || session.expiresAt < new Date()) return null
  if (!session.user.isActive || session.user.deletedAt) return null
  if (scopeForRole(session.user.role) !== scope) return null

  const user = session.user
  const accessToken = await signAccessToken({
    sub: user.id,
    rid: user.restaurantId,
    role: user.role,
    name: user.name,
    email: user.email,
    sid: session.id,
  })

  try {
    store.set(accessCookieName(scope), accessToken, cookieOptions(ACCESS_COOKIE_MAX_AGE))
  } catch {
    // Rendering a page — Next refuses cookie writes there. The user is still
    // authenticated for this request; only the saving of the new token is lost.
  }

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
    sessionId: session.id,
  }
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
    select: {
      id: true,
      user: {
        select: {
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
        },
      },
    },
  })

  // The session the token names is gone — usually because a concurrent refresh
  // rotated it. The refresh cookie will name the live one, so try that before
  // declaring the visitor signed out.
  if (!session) return renewFromRefreshToken(scope)
  if (!session.user.isActive || session.user.deletedAt) return null
  // A token from the wrong namespace (e.g. an admin token used as staff) is
  // rejected — the scope and the user's role must agree.
  if (scopeForRole(session.user.role) !== scope) return null

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    restaurantId: session.user.restaurantId,
    branchId: session.user.branchId ?? null,
    avatarUrl: session.user.avatarUrl,
    permissions: session.user.permissions,
    rolePermissions: activeRolePermissions(session.user.staffRole),
    sessionId: session.id,
  }
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
 * which returns the same user either way.
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
