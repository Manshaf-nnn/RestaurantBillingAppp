import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import type { UserRole } from '@prisma/client'

/**
 * JWT issuing / verification.
 *
 * Uses `jose` so the same code runs in the Node runtime (route handlers,
 * server actions) and the Edge runtime (middleware).
 */

export const ACCESS_COOKIE = 'ros_at'
export const REFRESH_COOKIE = 'ros_rt'
export const GUEST_COOKIE = 'ros_gs'
export const CSRF_COOKIE = 'ros_csrf'

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
export type RefreshTokenClaims = JWTPayload & { sub: string; sid: string }

function secret(name: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'): Uint8Array {
  const value = process.env[name]
  if (!value || value.length < 32) {
    throw new Error(`${name} is missing or shorter than 32 characters`)
  }
  return new TextEncoder().encode(value)
}

export function accessTokenTtl(): string {
  return process.env.ACCESS_TOKEN_TTL || '15m'
}

export function refreshTokenTtlDays(): number {
  const parsed = Number(process.env.REFRESH_TOKEN_TTL_DAYS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(accessTokenTtl())
    .sign(secret('JWT_ACCESS_SECRET'))
}

export async function signRefreshToken(claims: { sub: string; sid: string }): Promise<string> {
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${refreshTokenTtlDays()}d`)
    .sign(secret('JWT_REFRESH_SECRET'))
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

export async function verifyRefreshToken(token: string): Promise<RefreshTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret('JWT_REFRESH_SECRET'), {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    return payload as RefreshTokenClaims
  } catch {
    return null
  }
}

/**
 * `Secure` must track the *transport*, not `NODE_ENV`. A Secure cookie is
 * dropped by some browsers (Safari) over plain HTTP, which would let login
 * "succeed" server-side while the browser never stores the session. So we mark
 * cookies Secure only when the site is actually served over HTTPS.
 */
export function cookieOptions(maxAgeSeconds: number) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  return {
    httpOnly: true,
    secure: appUrl.startsWith('https://'),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}

/** Access-cookie lifetime slightly exceeds the JWT so expiry is decided by the JWT. */
export const ACCESS_COOKIE_MAX_AGE = 60 * 60
export const REFRESH_COOKIE_MAX_AGE = () => refreshTokenTtlDays() * 24 * 60 * 60
export const GUEST_COOKIE_MAX_AGE = 60 * 60 * 12
