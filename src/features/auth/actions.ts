'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { UserRole } from '@prisma/client'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { AppError, ForbiddenError } from '@/lib/errors'
import { landingFor } from '@/lib/rbac'
import { slugify } from '@/lib/utils'
import { appUrl } from '@/lib/env'
import { defaultCategoryRows } from '@/features/menu/default-categories'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requireUser } from '@/server/auth/guard'
import { cookieOptions } from '@/server/auth/jwt'
import {
  assessPasswordStrength,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '@/server/auth/password'
import { homeFor } from '@/features/access/sidebar-access'
import {
  clearSessionCookiesOwnedBy,
  createSession,
  destroySession,
  getAdminUser,
  getCurrentUser,
  permissionSubjectFor,
  revokeAllSessions,
} from '@/server/auth/session'
import { prisma } from '@/server/db/prisma'
import { hostOwnedByAnotherRestaurant, requestHost } from '@/server/db/tenant'
import { clientIp, enforceRateLimit } from '@/server/security/rate-limit'
import { sendMail, verificationEmail } from '@/server/mailer'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  newPasswordSchema,
  registerSchema,
  resetCodeSchema,
  updateProfileSchema,
} from './schema'
import { seedDefaultAccounts } from '@/features/payments/accounts'
import { secondFactorGate } from './mfa-gate'
import {
  FLOW_MAX_AGE_MS,
  completeReset,
  openFlow,
  requestResetCode,
  sealFlow,
  verifyResetCode,
  type ResetFlow,
} from './password-reset'

const MAX_FAILED_LOGINS = 8
const LOCKOUT_MINUTES = 15
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

// ── login ────────────────────────────────────────────────────────────────────

/**
 * What a sign-in attempt can come back with.
 *
 * `mfaRequired` is the half-way state: the password was right, the account has
 * a second factor, and no code was sent. No session exists yet. The form shows
 * the code field and resubmits the same credentials with the code filled in.
 */
export type LoginResult = { redirectTo: string } | { mfaRequired: true }

export async function login(input: unknown): Promise<ActionResult<LoginResult>> {
  return runAction(loginSchema, input, async (data): Promise<LoginResult> => {
    // Two-dimensional limiting: per IP and per account. `clientIp` returns
    // null outside a request scope, where `enforceRateLimit` derives it itself
    // and finds the same nothing — so undefined and null mean the same here.
    const ip = await clientIp()
    await enforceRateLimit('login', ip ?? undefined)
    await enforceRateLimit('login', `email:${data.email}`)

    const user = await prisma.user.findUnique({ where: { email: data.email } })

    // Always run a comparison so response time does not reveal account existence.
    const passwordOk = user
      ? await verifyPassword(data.password, user.passwordHash)
      : await verifyPassword(data.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv')

    if (!user || !passwordOk) {
      if (user) {
        const failed = user.failedLogins + 1
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLogins: failed,
            lockedUntil:
              failed >= MAX_FAILED_LOGINS
                ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
                : user.lockedUntil,
          },
        })
        await audit({
          restaurantId: user.restaurantId,
          userId: user.id,
          action: AUDIT_ACTIONS.LOGIN_FAILED,
          entity: 'User',
          entityId: user.id,
        })
      }
      /*
       * Not UnauthorizedError. `callAction` reads code UNAUTHORIZED as "the
       * session ran out": it tries a refresh and then replaces the message
       * with "Your session expired. Sign in again" — so a mistyped password
       * on the sign-in page told people their session had expired. Same 401,
       * its own code, the way MFA_BAD_CODE already does it.
       */
      throw new AppError('Incorrect email or password', 401, 'INVALID_CREDENTIALS')
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)
      throw new ForbiddenError(
        `Too many failed attempts. This account is locked for ${minutes} more minute(s).`,
      )
    }

    if (!user.isActive || user.deletedAt) {
      throw new ForbiddenError('This account has been deactivated. Contact your manager.')
    }

    /*
     * ── One restaurant per domain ─────────────────────────────────────────
     *
     * A restaurant with its own address should not be somewhere another
     * restaurant's staff can sign in. Nothing leaks if they do — tenancy comes
     * from the session, so they would see their own data — but seeing your own
     * dashboard at somebody else's web address reads exactly like a leak, and
     * it is one line to prevent.
     *
     * Only applies where the host names a tenant. On the shared platform
     * address everyone signs in as before.
     */
    const owner = await hostOwnedByAnotherRestaurant(user.restaurantId, await requestHost())
    if (owner) {
      throw new ForbiddenError(
        `This address belongs to ${owner.name}. Sign in at ${appUrl()}/login instead.`,
      )
    }

    /*
     * ── The second factor, for accounts that have one ─────────────────────
     *
     * Everything above has already been satisfied: the password is right, the
     * account is not locked, not deactivated, and on the right domain. Only now
     * is the second factor considered, so a wrong code reveals nothing about
     * the password and a right code cannot rescue a wrong one.
     *
     * No session exists until the code passes. The first submission has no
     * code and is answered with `mfaRequired`; the form resubmits the same
     * credentials plus the code. See `mfa-gate.ts` for why that is stateless.
     */
    const gate = await secondFactorGate({ userId: user.id, code: data.code })

    if (gate.outcome === 'code-required') {
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        action: AUDIT_ACTIONS.MFA_CHALLENGED,
        entity: 'User',
        entityId: user.id,
      })
      return { mfaRequired: true as const }
    }

    if (gate.outcome === 'bad-code') {
      // Guessing a code is guessing a credential: same limiter shape, same
      // lockout arithmetic as a wrong password.
      await enforceRateLimit('mfa', `user:${user.id}`)
      const failed = user.failedLogins + 1
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLogins: failed,
          lockedUntil:
            failed >= MAX_FAILED_LOGINS
              ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
              : user.lockedUntil,
        },
      })
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        action: AUDIT_ACTIONS.MFA_FAILED,
        entity: 'User',
        entityId: user.id,
      })
      throw new AppError('That code is not right — check the clock on your phone', 401, 'MFA_BAD_CODE')
    }

    if (gate.outcome === 'ok' && gate.usedRecoveryCode) {
      // Ten exist and each works once; spending one is worth a line of its own.
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.MFA_RECOVERY_USED,
        entity: 'User',
        entityId: user.id,
      })
    }

    // `remember` is finally read: unticked is a shift-length session whose
    // refresh cookie dies with the browser.
    await createSession(user.id, { persistent: data.remember })
    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.LOGIN,
      entity: 'User',
      entityId: user.id,
      after: { mfa: gate.outcome === 'ok', persistent: data.remember },
    })

    return { redirectTo: await landingAfterLogin(user) }
  })
}

/**
 * Where a user lands, accounting for tenant approval status.
 *
 * The role half is `homeFor` in `features/dashboard/nav` — the built-in's
 * home, or for somebody on one of the restaurant's own roles the first tab of
 * the sidebar they were given. This wraps it with the two things that outrank
 * either: a platform operator, and a restaurant that is not approved yet.
 */
async function landingAfterLogin(user: {
  id: string
  role: UserRole
  restaurantId: string | null
}): Promise<string> {
  if (user.role === 'SUPER_ADMIN') return '/admin'
  if (!user.restaurantId) return '/onboarding'

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: user.restaurantId },
    select: { status: true },
  })
  if (restaurant && restaurant.status !== 'ACTIVE') return '/pending-approval'

  const subject = await permissionSubjectFor(user.id)
  return subject ? homeFor(subject) : landingFor(user.role)
}

// ── registration (new restaurant + owner) ────────────────────────────────────

export async function register(input: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  return runAction(registerSchema, input, async (data): Promise<{ redirectTo: string }> => {
    await enforceRateLimit('register')

    const strength = assessPasswordStrength(data.password)
    if (strength.issues.length) {
      throw new AppError(strength.issues[0], 422, 'WEAK_PASSWORD')
    }

    const existing = await prisma.user.findUnique({ where: { email: data.email } })
    if (existing) {
      throw new AppError('An account with that email already exists', 409, 'EMAIL_TAKEN')
    }

    // Unique tenant slug — the QR ordering URL depends on it.
    const base = slugify(data.restaurantName) || 'restaurant'
    let slug = base
    for (let attempt = 1; await prisma.restaurant.findUnique({ where: { slug } }); attempt += 1) {
      slug = `${base}-${attempt}`
      if (attempt > 50) {
        slug = `${base}-${generateToken(4).toLowerCase()}`
        break
      }
    }

    const passwordHash = await hashPassword(data.password)

    // Every registration is a request: the restaurant is created disabled and
    // must be approved by a platform admin before it can be used.
    const { user } = await prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          slug,
          name: data.restaurantName,
          email: data.email,
          phone: data.phone,
          currency: data.currency,
          plan: 'TRIAL',
          status: 'PENDING',
          isActive: false,
          paymentConfig: { cash: true, card: true, qr: true, online: false },
          features: { reservations: true, loyalty: true, happyHour: false, inventory: true },
        },
      })

      /*
       * The book of accounts, up front — the same argument as the main branch
       * below. A payment resolves a real account row, so a restaurant with none
       * could not take money at all, and the owner renames these to their real
       * banks the first time they open Payment details.
       */
      await seedDefaultAccounts(tx, restaurant.id)

      // The owner is W-0001 of their own restaurant.
      const created = await tx.user.create({
        data: {
          staffCode: 'W-0001',
          restaurantId: restaurant.id,
          email: data.email,
          name: data.ownerName,
          phone: data.phone,
          passwordHash,
          role: 'OWNER',
        },
      })

      /*
       * Every restaurant gets its main location up front.
       *
       * It used to be created lazily by `ensureDefaultBranch` the first time
       * somebody opened an inventory screen, which was fine while a branch was
       * optional. Tables and orders now require one, so a restaurant with no
       * branch could not seat a guest or take an order — the whole point of
       * signing up. Creating it here, in the same transaction as the
       * restaurant, means that state cannot exist.
       */
      const mainBranch = await tx.branch.create({
        data: {
          restaurantId: restaurant.id,
          name: 'Main',
          code: 'MAIN',
          type: 'BRANCH',
          isDefault: true,
        },
      })

      // A restaurant is unusable without a floor — start with 8 tables.
      await tx.restaurantTable.createMany({
        data: Array.from({ length: 8 }, (_, index) => ({
          restaurantId: restaurant.id,
          branchId: mainBranch.id,
          number: String(index + 1),
          capacity: index < 4 ? 2 : 4,
          sortOrder: index,
        })),
      })

      // Every restaurant starts with a fixed set of menu categories.
      await tx.category.createMany({ data: defaultCategoryRows(restaurant.id) })

      return { user: created, restaurant }
    })

    const token = generateToken(24)
    await prisma.verificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        purpose: 'EMAIL_VERIFICATION',
        expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
      },
    })
    await sendMail({ to: user.email, ...verificationEmail(user.name, token) })

    await createSession(user.id)
    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.REGISTER,
      entity: 'Restaurant',
      entityId: user.restaurantId,
      after: { name: data.restaurantName, slug },
    })

    // The owner is signed in but parked on the pending screen until an admin
    // approves the request; then their dashboard unlocks.
    return { redirectTo: '/pending-approval' }
  })
}

// ── logout ───────────────────────────────────────────────────────────────────

/** Sign out of the staff/restaurant session only (leaves any admin session). */
export async function logout(): Promise<never> {
  const user = await getCurrentUser()
  if (user) {
    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.LOGOUT,
      entity: 'User',
      entityId: user.id,
    })
  }
  await destroySession('staff')
  redirect('/login')
}

/** Sign out of the platform-admin session only (leaves any staff session). */
export async function logoutAdmin(): Promise<never> {
  const admin = await getAdminUser()
  if (admin) {
    await audit({
      userId: admin.id,
      actorName: admin.name,
      action: AUDIT_ACTIONS.LOGOUT,
      entity: 'User',
      entityId: admin.id,
    })
  }
  await destroySession('admin')
  redirect('/admin/login')
}

// ── password reset (prisma/email.md) ────────────────────────────────────────
//
// The flow's state lives in two httpOnly cookies scoped to /forgot-password:
// the signed FLOW (which row, which browser, which address) and, after a
// correct code, the GRANT. Nothing secret in a URL. The rules live in
// ./password-reset.ts; these actions own the cookies and the clock.

const FLOW_COOKIE = 'ros_pr_flow'
const GRANT_COOKIE = 'ros_pr_grant'
const FLOW_PATH = '/forgot-password'
/** Every reply takes at least this long, so the work behind it is not on the clock. */
const REPLY_FLOOR_MS = 1_500

function flowCookieOptions() {
  return { ...cookieOptions(FLOW_MAX_AGE_MS / 1000), path: FLOW_PATH, sameSite: 'strict' as const }
}

async function readFlow(): Promise<ResetFlow | null> {
  const store = await cookies()
  return openFlow(store.get(FLOW_COOKIE)?.value)
}

async function writeFlow(flow: ResetFlow): Promise<void> {
  const store = await cookies()
  store.set(FLOW_COOKIE, sealFlow(flow), flowCookieOptions())
}

async function clearFlowCookies(): Promise<void> {
  const store = await cookies()
  // Same path as they were set with — `delete()` clears at "/" and would miss them.
  store.set(FLOW_COOKIE, '', { ...flowCookieOptions(), maxAge: 0 })
  store.set(GRANT_COOKIE, '', { ...flowCookieOptions(), maxAge: 0 })
}

/** Hold the reply until the floor, whatever happened inside. */
async function padded<T>(work: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    return await work()
  } finally {
    const remaining = REPLY_FLOOR_MS - (Date.now() - started)
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
  }
}

const NEUTRAL_SENT = 'If an account exists for this email, a reset code has been sent.'

async function issueFor(
  email: string,
  from: ResetFlow['from'],
): Promise<{ cooldownSeconds: number }> {
  const result = await requestResetCode({ email, ip: await clientIp(), host: await requestHost() })
  await writeFlow({
    rowId: result.kind === 'issued' ? result.rowId : null,
    nonce: result.nonce,
    email,
    from,
    iat: Date.now(),
  })
  return { cooldownSeconds: result.kind === 'cooldown' ? result.retryAfterSeconds : 60 }
}

/**
 * Step 1: "Send reset code". The reply is the same for every address.
 */
export async function requestPasswordResetCode(
  input: unknown,
): Promise<ActionResult<{ cooldownSeconds: number }>> {
  return runAction(
    forgotPasswordSchema,
    input,
    (data) => padded(() => issueFor(data.email, data.from ?? 'staff')),
    NEUTRAL_SENT,
    'requestPasswordResetCode',
  )
}

/** Step 1 again, for the address the flow cookie already names. */
export async function resendPasswordResetCode(): Promise<ActionResult<{ cooldownSeconds: number }>> {
  return runSafe(
    () =>
      padded(async () => {
        const flow = await readFlow()
        if (!flow) throw new AppError('Start again from the sign-in page.', 400, 'RESET_EXPIRED')
        return issueFor(flow.email, flow.from)
      }),
    NEUTRAL_SENT,
    'resendPasswordResetCode',
  )
}

/** Step 2: the six digits. A correct code earns the grant cookie. */
export async function verifyPasswordResetCode(input: unknown): Promise<ActionResult<{ verified: true }>> {
  return runAction(
    resetCodeSchema,
    input,
    (data) =>
      padded(async () => {
        const flow = await readFlow()
        if (!flow) throw new AppError('Start again from the sign-in page.', 400, 'RESET_EXPIRED')
        const { grant } = await verifyResetCode({
          rowId: flow.rowId,
          nonce: flow.nonce,
          email: flow.email,
          code: data.code,
        })
        const store = await cookies()
        store.set(GRANT_COOKIE, grant, flowCookieOptions())
        return { verified: true as const }
      }),
    'Code verified.',
    'verifyPasswordResetCode',
  )
}

/** Step 3: the new password. Consumes the grant, revokes every session, clears this browser. */
export async function completePasswordReset(
  input: unknown,
): Promise<ActionResult<{ redirectTo: string }>> {
  return runAction(
    newPasswordSchema,
    input,
    async (data) => {
      const store = await cookies()
      const flow = openFlow(store.get(FLOW_COOKIE)?.value)
      const grant = store.get(GRANT_COOKIE)?.value
      if (!grant) throw new AppError('This reset has expired. Request a new code.', 400, 'RESET_EXPIRED')

      const result = await completeReset({ grant, password: data.password })

      await clearFlowCookies()
      // The browser that reset the password may itself be signed in as that
      // person; its access token would loop it between /login and /dashboard.
      await clearSessionCookiesOwnedBy(result.userId)

      const admin = result.role === 'SUPER_ADMIN' || flow?.from === 'admin'
      return { redirectTo: admin ? '/admin/login?reset=1' : '/login?reset=1&switch=1' }
    },
    'Password reset successfully. Please sign in with your new password.',
    'completePasswordReset',
  )
}

// ── email verification ───────────────────────────────────────────────────────

export async function verifyEmail(token: string): Promise<ActionResult<{ verified: boolean }>> {
  return runSafe(async () => {
    const record = await prisma.verificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
    })

    if (
      !record ||
      record.purpose !== 'EMAIL_VERIFICATION' ||
      record.usedAt ||
      record.expiresAt < new Date()
    ) {
      throw new AppError('This confirmation link is invalid or has expired', 400, 'INVALID_TOKEN')
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      }),
      prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ])

    return { verified: true }
  }, 'Email confirmed.')
}

export async function resendVerification(): Promise<ActionResult<{ sent: boolean }>> {
  return runSafe(async () => {
    const current = await requireUser()
    await enforceRateLimit('passwordReset', `verify:${current.id}`)

    const user = await prisma.user.findUnique({ where: { id: current.id } })
    if (!user || user.emailVerifiedAt) return { sent: false }

    const token = generateToken(24)
    await prisma.verificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        purpose: 'EMAIL_VERIFICATION',
        expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
      },
    })
    await sendMail({ to: user.email, ...verificationEmail(user.name, token) })
    return { sent: true }
  }, 'Confirmation email sent.')
}

// ── account ──────────────────────────────────────────────────────────────────

export async function changePassword(input: unknown): Promise<ActionResult<{ changed: true }>> {
  return runAction(
    changePasswordSchema,
    input,
    async (data) => {
      const current = await requireUser()
      const user = await prisma.user.findUniqueOrThrow({ where: { id: current.id } })

      if (!(await verifyPassword(data.currentPassword, user.passwordHash))) {
        // Its own code, not UNAUTHORIZED — see INVALID_CREDENTIALS in `login`.
        throw new AppError('Your current password is incorrect', 401, 'WRONG_CURRENT_PASSWORD')
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(data.password) },
      })
      // Keep the current session, drop everything else.
      await revokeAllSessions(user.id, current.sessionId)

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.PASSWORD_CHANGED,
        entity: 'User',
        entityId: user.id,
      })

      return { changed: true as const }
    },
    'Password changed. Other devices have been signed out.',
  )
}

export async function updateProfile(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    updateProfileSchema,
    input,
    async (data) => {
      const current = await requireUser()
      const updated = await prisma.user.update({
        where: { id: current.id },
        data: {
          name: data.name,
          phone: data.phone || null,
          avatarUrl: data.avatarUrl || null,
        },
      })
      revalidatePath('/dashboard/settings')
      return { id: updated.id }
    },
    'Profile updated.',
  )
}

export async function signOutEverywhereElse(): Promise<ActionResult<{ revoked: number }>> {
  return runSafe(async () => {
    const current = await requireUser()
    const revoked = await revokeAllSessions(current.id, current.sessionId)
    await audit({
      restaurantId: current.restaurantId,
      userId: current.id,
      actorName: current.name,
      action: AUDIT_ACTIONS.SESSIONS_REVOKED,
      entity: 'Session',
      after: { revoked },
    })
    return { revoked }
  }, 'Signed out on all other devices.')
}

export async function listSessions() {
  const current = await requireUser()
  const sessions = await prisma.session.findMany({
    where: { userId: current.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
    },
  })
  return sessions.map((session) => ({ ...session, current: session.id === current.sessionId }))
}
