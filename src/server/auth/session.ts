import 'server-only'
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
  avatarUrl: string | null
  permissions: string[]
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
    include: { user: true },
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
    avatarUrl: user.avatarUrl,
    permissions: user.permissions,
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
async function resolveUser(scope: SessionScope): Promise<AuthUser | null> {
  const store = await cookies()
  const token = store.get(accessCookieName(scope))?.value
  if (!token) return null

  const claims = await verifyAccessToken(token)
  if (!claims?.sub || !claims.sid) return null

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
          avatarUrl: true,
          permissions: true,
          isActive: true,
          deletedAt: true,
        },
      },
    },
  })

  if (!session || !session.user.isActive || session.user.deletedAt) return null
  // A token from the wrong namespace (e.g. an admin token used as staff) is
  // rejected — the scope and the user's role must agree.
  if (scopeForRole(session.user.role) !== scope) return null

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    restaurantId: session.user.restaurantId,
    avatarUrl: session.user.avatarUrl,
    permissions: session.user.permissions,
    sessionId: session.id,
  }
}

/** The signed-in staff / restaurant user (dashboard, kitchen, cashier, …). */
export async function getCurrentUser(): Promise<AuthUser | null> {
  return resolveUser('staff')
}

/** The signed-in platform admin — a completely separate session from staff. */
export async function getAdminUser(): Promise<AuthUser | null> {
  return resolveUser('admin')
}

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
