import 'server-only'

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

import { AppError, RateLimitError } from '@/lib/errors'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import {
  assessPasswordStrength,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '@/server/auth/password'
import { lockUserSessions, revokeAllSessions } from '@/server/auth/session'
import { guardLocks, prisma } from '@/server/db/prisma'
import { hostOwnedByAnotherRestaurant } from '@/server/db/tenant'
import { captureError } from '@/server/errors'
import { passwordResetCodeEmail, sendMail } from '@/server/mailer'
import { isSmtpConfigured } from '@/lib/env'
import { enforceRateLimit } from '@/server/security/rate-limit'

import { passwordSchema } from './schema'

/**
 * Forgot password by emailed six-digit code (prisma/email.md).
 *
 * ── The three steps ─────────────────────────────────────────────────────────
 *
 *   request  → a row and a code; the code goes by email, the row id and a
 *              nonce go to the browser in a signed cookie.
 *   verify   → the code against the row's keyed hash; a correct one earns a
 *              random GRANT, stored hashed, handed to the browser.
 *   complete → the grant is consumed atomically, the password swapped, every
 *              session revoked, in one transaction.
 *
 * Nothing secret ever travels in a URL, and nothing secret is ever stored
 * in the clear: the code as an HMAC keyed on the row's own id, the grant as
 * a SHA-256 of 256 random bits.
 *
 * ── Nothing here says whether an address exists ─────────────────────────────
 *
 * An address with no eligible account still gets a row — a DECOY, `userId`
 * null — with the same cooldown, the same attempt counting, the same lockout
 * and the same daily budget, keyed on the address's hash. It can never be
 * redeemed. A request that would fail for everyone (email not configured,
 * the provider down in the last few minutes, the limits) fails BEFORE the
 * address is looked up, so it fails the same way for every address. The
 * actions pad every reply to a floor so the database work is not visible in
 * the clock either. What remains is documented in AUTH-SESSIONS.md.
 *
 * Cookie-free by design, like `session.ts`'s core: the actions own the
 * cookies, and this file is testable with plain function calls.
 */

export const CODE_TTL_MS = 10 * 60_000
export const GRANT_TTL_MS = 10 * 60_000
export const RESEND_COOLDOWN_MS = 60_000
/** Wrong codes a single address may burn in a day before it is refused new codes. */
export const DAILY_FAILURE_BUDGET = 10
const BUDGET_WINDOW_MS = 24 * 3_600_000
/** How long after a failed send every request is refused up front. */
const DEGRADED_MS = 5 * 60_000
const DEGRADED_KEY = 'mail.degradedUntil'

// ── Keys and hashes ──────────────────────────────────────────────────────────

function appSecret(): string {
  const secret = process.env.JWT_ACCESS_SECRET
  if (!secret) throw new AppError('JWT_ACCESS_SECRET is not set', 500, 'NO_APP_SECRET')
  return secret
}

/** One key per purpose, so a hash made for one can never be checked as another. */
function keyFor(purpose: 'code' | 'cookie' | 'email' | 'ip'): Buffer {
  return createHash('sha256').update(`pwreset:v1:${purpose}:${appSecret()}`).digest()
}

function hmac(purpose: 'code' | 'cookie' | 'email' | 'ip', value: string): string {
  return createHmac('sha256', keyFor(purpose)).update(value).digest('hex')
}

export const emailHashOf = (email: string) => hmac('email', email.trim().toLowerCase())
const codeHashOf = (rowId: string, code: string) => hmac('code', `${rowId}:${code}`)
const ipHashOf = (ip: string | null) => (ip ? hmac('ip', ip) : null)

function same(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/** Six digits, `randomInt` so every value is equally likely; zero-padded. */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

// ── The signed flow state (what the browser holds) ───────────────────────────

export interface ResetFlow {
  /** Null while the address is in its resend cooldown with no new code issued. */
  rowId: string | null
  nonce: string
  email: string
  /** Where "Back to sign in" goes. */
  from: 'staff' | 'admin'
  iat: number
}

export const FLOW_MAX_AGE_MS = 15 * 60_000

export function sealFlow(flow: ResetFlow): string {
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url')
  return `${payload}.${hmac('cookie', payload)}`
}

/** The flow a cookie carries, or null if it was tampered with or is too old. */
export function openFlow(raw: string | undefined, now = new Date()): ResetFlow | null {
  if (!raw) return null
  const [payload, signature] = raw.split('.')
  if (!payload || !signature || !same(hmac('cookie', payload), signature)) return null
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ResetFlow
    if (typeof flow.email !== 'string' || typeof flow.nonce !== 'string' || typeof flow.iat !== 'number') return null
    if (now.getTime() - flow.iat > FLOW_MAX_AGE_MS) return null
    return { ...flow, from: flow.from === 'admin' ? 'admin' : 'staff' }
  } catch {
    return null
  }
}

/** `nila@gmail.com` → `n•••@gmail.com`, enough to recognise, not enough to copy. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 1)}•••@${domain}`
}

// ── Uniform refusals ─────────────────────────────────────────────────────────

export class ResetUnavailable extends AppError {
  constructor(message: string) {
    super(message, 503, 'RESET_UNAVAILABLE')
  }
}

async function degradedUntil(): Promise<Date | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: DEGRADED_KEY } })
  if (!row) return null
  const until = new Date(row.value)
  return Number.isNaN(until.getTime()) || until <= new Date() ? null : until
}

async function markDegraded(now: Date): Promise<void> {
  const value = new Date(now.getTime() + DEGRADED_MS).toISOString()
  await prisma.platformSetting.upsert({
    where: { key: DEGRADED_KEY },
    create: { key: DEGRADED_KEY, value },
    update: { value },
  })
}

/**
 * Refusals that apply to every address alike, checked before any lookup.
 *
 * Exported so the verify step can refuse the same way: a code cannot be
 * verified while the flow is unavailable to request, and saying otherwise
 * would let the verify step confirm what the request step hid.
 */
export async function assertResetAvailable(now = new Date()): Promise<void> {
  if (!isSmtpConfigured()) {
    throw new ResetUnavailable(
      'Password reset by email is not set up on this server yet. Ask the platform administrator to reset your password.',
    )
  }
  if (await degradedUntil()) {
    throw new ResetUnavailable("We couldn't send emails just now. Please try again in a few minutes.")
  }
  void now
}

/** Wrong codes this address has burned in the last day, decoys included. */
async function failuresToday(emailHash: string, now: Date): Promise<number> {
  const rows = await prisma.passwordResetCode.findMany({
    where: { emailHash, createdAt: { gt: new Date(now.getTime() - BUDGET_WINDOW_MS) } },
    select: { attempts: true, verifiedAt: true },
  })
  // A verified row's last attempt was the right one.
  return rows.reduce((sum, row) => sum + row.attempts - (row.verifiedAt ? 1 : 0), 0)
}

function budgetExhausted(): never {
  throw new RateLimitError(3_600)
}

// ── Step 1: request ──────────────────────────────────────────────────────────

export type RequestResult =
  | { kind: 'issued'; rowId: string; nonce: string }
  | { kind: 'cooldown'; nonce: string; retryAfterSeconds: number }

/**
 * Issue a code for this address, or say how long until the next one may be.
 *
 * Always returns the same shape for a real account and for an address with
 * none; only a real account gets an email.
 */
export async function requestResetCode(params: {
  email: string
  ip: string | null
  host: string | null
  now?: Date
}): Promise<RequestResult> {
  const now = params.now ?? new Date()
  const email = params.email.trim().toLowerCase()
  const emailHash = emailHashOf(email)

  await assertResetAvailable(now)
  await enforceRateLimit('resetRequest', `email:${emailHash}`)
  await enforceRateLimit('resetRequest')
  if ((await failuresToday(emailHash, now)) >= DAILY_FAILURE_BUDGET) budgetExhausted()

  const nonce = randomBytes(16).toString('base64url')
  const rowId = randomUUID()
  const code = newCode()

  /*
   * Cooldown and insert under one advisory lock on the address, so two
   * requests arriving together cannot both pass the cooldown and both issue
   * a code — that would be two emails and ten guesses.
   */
  const issued = await prisma.$transaction(async (tx) => {
    await guardLocks(tx)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pwreset:${emailHash}`}))`

    const latest = await tx.passwordResetCode.findFirst({
      where: { emailHash, voidedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (latest) {
      const elapsed = now.getTime() - latest.createdAt.getTime()
      if (elapsed < RESEND_COOLDOWN_MS) {
        return { user: null, cooldown: Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000) }
      }
    }

    const user = await tx.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true, role: true, restaurantId: true, isActive: true, deletedAt: true },
    })
    const eligible =
      user !== null &&
      user.isActive &&
      !user.deletedAt &&
      !(await hostOwnedByAnotherRestaurant(user.restaurantId, params.host))

    await tx.passwordResetCode.create({
      data: {
        id: rowId,
        userId: eligible ? user.id : null,
        emailHash,
        codeHash: codeHashOf(rowId, code),
        flowNonceHash: hashToken(nonce),
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
        requestedIpHash: ipHashOf(params.ip),
        // One clock for the whole row: cooldown and budget read this back.
        createdAt: now,
      },
    })
    return { user: eligible ? user : null, cooldown: 0 }
  })

  if (issued.cooldown > 0) return { kind: 'cooldown', nonce, retryAfterSeconds: issued.cooldown }

  if (issued.user) {
    const result = await sendMail({ to: issued.user.email, ...passwordResetCodeEmail(code) })
    if (!result.sent) {
      /*
       * The row is voided rather than left live: a code nobody received is a
       * code an attacker could still guess at. The flag makes every request
       * in the next few minutes fail up front, for everyone, so the failure
       * itself does not single out real addresses.
       */
      await prisma.passwordResetCode.update({ where: { id: rowId }, data: { voidedAt: now } })
      await markDegraded(now)
      await captureError({
        severity: 'ERROR',
        kind: 'mail',
        operation: 'requestResetCode',
        message: result.configured
          ? 'Password reset code could not be delivered: the SMTP provider refused or timed out.'
          : 'Password reset code could not be delivered: SMTP is not configured.',
      })
      throw new AppError("We couldn't send the code. Please try again.", 502, 'RESET_SEND_FAILED')
    }

    // Only once the new code is in the post does the old one stop working.
    await prisma.passwordResetCode.updateMany({
      where: {
        id: { not: rowId },
        usedAt: null,
        OR: [{ emailHash }, { userId: issued.user.id }],
      },
      data: { usedAt: now },
    })
    await audit({
      restaurantId: issued.user.restaurantId,
      userId: issued.user.id,
      actorName: issued.user.name,
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      entity: 'User',
      entityId: issued.user.id,
    })
  }

  return { kind: 'issued', rowId, nonce }
}

// ── Step 2: verify ───────────────────────────────────────────────────────────

const INVALID = () => new AppError('That code is invalid or has expired. Request a new one.', 400, 'RESET_CODE_INVALID')
const LOCKED = () => new AppError('Too many wrong attempts. Request a new code.', 400, 'RESET_CODE_LOCKED')

/**
 * Check a code. A correct one earns a grant; a wrong one costs an attempt.
 *
 * The attempt is charged BEFORE the comparison, with a compare-and-swap that
 * refuses once the row is used, expired or out of attempts — so two guesses
 * arriving together are two attempts, never one, and the sixth guess is
 * refused even when it is right.
 */
export async function verifyResetCode(params: {
  rowId: string | null
  nonce: string
  email: string
  code: string
  now?: Date
}): Promise<{ grant: string }> {
  const now = params.now ?? new Date()
  await assertResetAvailable(now)
  await enforceRateLimit('resetVerifyIp')

  const emailHash = emailHashOf(params.email)
  if (!params.rowId) throw INVALID()
  if ((await failuresToday(emailHash, now)) >= DAILY_FAILURE_BUDGET) budgetExhausted()

  const row = await prisma.passwordResetCode.findUnique({ where: { id: params.rowId } })
  if (
    !row ||
    !same(row.emailHash, emailHash) ||
    !same(row.flowNonceHash, hashToken(params.nonce)) ||
    row.usedAt ||
    row.voidedAt ||
    row.expiresAt <= now
  ) {
    throw INVALID()
  }

  // The instant as ISO text cast to `timestamp`: a JS Date bound directly is
  // compared in the connection's zone, which against a naive TIMESTAMP(3)
  // column is off by the local offset and matched nothing (Colombo, +5:30).
  const charged = await prisma.$queryRaw<Array<{ attempts: number; maxAttempts: number }>>`
    UPDATE "password_reset_codes"
    SET "attempts" = "attempts" + 1
    WHERE "id" = ${row.id}
      AND "usedAt" IS NULL
      AND "voidedAt" IS NULL
      AND "expiresAt" > ${now.toISOString()}::timestamp
      AND "attempts" < "maxAttempts"
    RETURNING "attempts", "maxAttempts"`
  const charge = charged[0]
  if (!charge) throw LOCKED()

  // A decoy row has no code anyone was sent; it compares wrong every time.
  const correct = row.userId !== null && same(row.codeHash, codeHashOf(row.id, params.code))

  if (!correct) {
    if (charge.attempts >= charge.maxAttempts) {
      await prisma.passwordResetCode.update({ where: { id: row.id }, data: { lockedAt: now } })
      if (row.userId) {
        await audit({
          userId: row.userId,
          action: AUDIT_ACTIONS.PASSWORD_RESET_CODE_LOCKED,
          entity: 'PasswordResetCode',
          entityId: row.id,
          after: { attempts: charge.attempts },
        })
      }
      throw LOCKED()
    }
    throw INVALID()
  }

  /*
   * Right. A fresh grant every time: a double-submitted correct code rotates
   * the grant rather than dead-ending on "already verified", and the browser
   * always holds the one that works.
   */
  const grant = generateToken(32)
  const { count } = await prisma.passwordResetCode.updateMany({
    where: { id: row.id, usedAt: null, voidedAt: null, expiresAt: { gt: now } },
    data: { verifiedAt: now, grantHash: hashToken(grant), grantExpiresAt: new Date(now.getTime() + GRANT_TTL_MS) },
  })
  if (count !== 1) throw INVALID()
  return { grant }
}

// ── Step 3: complete ─────────────────────────────────────────────────────────

const EXPIRED = () =>
  new AppError(
    'This reset has already been used or has expired. If you just set a new password, sign in with it; otherwise request a new code.',
    400,
    'RESET_EXPIRED',
  )

/**
 * Swap the password and end every session, once, for the holder of a grant.
 *
 * bcrypt (twice: is it the old password, and hash the new) runs BEFORE the
 * transaction — a hundred milliseconds of CPU has no business inside a lock.
 * The transaction is then short: consume the grant with a compare-and-swap
 * (two browsers holding the same grant → exactly one wins), re-check the
 * account, write the hash, revoke under the per-user session lock.
 */
export async function completeReset(params: {
  grant: string
  password: string
  now?: Date
}): Promise<{ userId: string; role: string; sessionsRevoked: number }> {
  const now = params.now ?? new Date()
  const grantHash = hashToken(params.grant)

  const row = await prisma.passwordResetCode.findUnique({
    where: { grantHash },
    include: { user: { select: { id: true, name: true, email: true, role: true, restaurantId: true, isActive: true, deletedAt: true, passwordHash: true } } },
  })
  if (!row || !row.user || row.usedAt || row.voidedAt || !row.grantExpiresAt || row.grantExpiresAt <= now) throw EXPIRED()

  // The policy, on the server, whatever the form said.
  const parsed = passwordSchema.safeParse(params.password)
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? 'Choose a stronger password', 422, 'WEAK_PASSWORD')
  const strength = assessPasswordStrength(parsed.data)
  if (strength.issues.length) throw new AppError(strength.issues[0] ?? 'Choose a stronger password', 422, 'WEAK_PASSWORD')
  if (await verifyPassword(parsed.data, row.user.passwordHash)) {
    throw new AppError('Choose a password you have not used before.', 422, 'PASSWORD_REUSED')
  }
  const passwordHash = await hashPassword(parsed.data)

  const userId = row.user.id
  const sessionsRevoked = await prisma.$transaction(async (tx) => {
    await guardLocks(tx)
    await lockUserSessions(tx, userId)

    const consumed = await tx.passwordResetCode.updateMany({
      where: { id: row.id, grantHash, usedAt: null, voidedAt: null, grantExpiresAt: { gt: now } },
      data: { usedAt: now },
    })
    if (consumed.count !== 1) throw EXPIRED()

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { isActive: true, deletedAt: true, email: true, emailVerifiedAt: true },
    })
    // Deactivated, removed, or re-addressed since the code went out: the code
    // proved possession of an inbox that is no longer this account's.
    if (!user || !user.isActive || user.deletedAt || !same(emailHashOf(user.email), row.emailHash)) throw EXPIRED()

    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        failedLogins: 0,
        lockedUntil: null,
        // The sign-in code an owner hands out IS the password; it is dead now,
        // and a stale one on the owner's screen would be a lie.
        signInCode: null,
        // Receiving the code proved the mailbox, which is all verification asks.
        emailVerifiedAt: user.emailVerifiedAt ?? now,
      },
    })
    await tx.passwordResetCode.updateMany({
      where: { id: { not: row.id }, usedAt: null, OR: [{ userId }, { emailHash: row.emailHash }] },
      data: { usedAt: now },
    })
    return revokeAllSessions(userId, undefined, tx)
  })

  await audit({
    restaurantId: row.user.restaurantId,
    userId,
    actorName: row.user.name,
    action: AUDIT_ACTIONS.PASSWORD_RESET,
    entity: 'User',
    entityId: userId,
    after: { method: 'email_code', sessionsRevoked },
  })

  return { userId, role: row.user.role, sessionsRevoked }
}

/** For the verify page: what the browser's flow cookie is about, and how long until it may resend. */
export async function describeFlow(flow: ResetFlow, now = new Date()): Promise<{ maskedEmail: string; cooldownSeconds: number }> {
  const latest = await prisma.passwordResetCode.findFirst({
    where: { emailHash: emailHashOf(flow.email), voidedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  const elapsed = latest ? now.getTime() - latest.createdAt.getTime() : RESEND_COOLDOWN_MS
  return {
    maskedEmail: maskEmail(flow.email),
    cooldownSeconds: Math.max(0, Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000)),
  }
}

/** For the new-password page: does this grant still open the door. */
export async function grantIsLive(grant: string | undefined, now = new Date()): Promise<boolean> {
  if (!grant) return false
  const row = await prisma.passwordResetCode.findUnique({
    where: { grantHash: hashToken(grant) },
    select: { usedAt: true, voidedAt: true, grantExpiresAt: true, userId: true },
  })
  return Boolean(row && row.userId && !row.usedAt && !row.voidedAt && row.grantExpiresAt && row.grantExpiresAt > now)
}
