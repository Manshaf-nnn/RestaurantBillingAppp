'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { UserRole } from '@prisma/client'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { AppError, ForbiddenError, UnauthorizedError } from '@/lib/errors'
import { ROLE_HOME } from '@/lib/rbac'
import { slugify } from '@/lib/utils'
import { defaultCategoryRows } from '@/features/menu/default-categories'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requireUser } from '@/server/auth/guard'
import {
  assessPasswordStrength,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '@/server/auth/password'
import {
  createSession,
  destroySession,
  getAdminUser,
  getCurrentUser,
  revokeAllSessions,
} from '@/server/auth/session'
import { prisma } from '@/server/db/prisma'
import { clientIp, enforceRateLimit } from '@/server/security/rate-limit'
import {
  passwordResetEmail,
  sendMail,
  verificationEmail,
} from '@/server/mailer'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './schema'

const MAX_FAILED_LOGINS = 8
const LOCKOUT_MINUTES = 15
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

// ── login ────────────────────────────────────────────────────────────────────

export async function login(input: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  return runAction(loginSchema, input, async (data) => {
    const ip = await clientIp()
    // Two-dimensional limiting: per IP and per account.
    await enforceRateLimit('login', ip)
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
      throw new UnauthorizedError('Incorrect email or password')
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

    await createSession(user.id)
    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.LOGIN,
      entity: 'User',
      entityId: user.id,
    })

    return { redirectTo: await landingFor(user.id, user.role, user.restaurantId) }
  })
}

/** Resolves where a user should land, accounting for tenant approval status. */
async function landingFor(
  _userId: string,
  role: UserRole,
  restaurantId: string | null,
): Promise<string> {
  if (role === 'SUPER_ADMIN') return '/admin'
  if (!restaurantId) return '/onboarding'

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { status: true },
  })
  if (restaurant && restaurant.status !== 'ACTIVE') return '/pending-approval'

  return ROLE_HOME[role]
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

// ── password reset ───────────────────────────────────────────────────────────

export async function requestPasswordReset(input: unknown): Promise<ActionResult<{ sent: true }>> {
  return runAction(
    forgotPasswordSchema,
    input,
    async (data) => {
      await enforceRateLimit('passwordReset')
      const user = await prisma.user.findUnique({ where: { email: data.email } })

      // Respond identically whether or not the account exists.
      if (user && user.isActive && !user.deletedAt) {
        const token = generateToken(24)
        await prisma.verificationToken.create({
          data: {
            userId: user.id,
            tokenHash: hashToken(token),
            purpose: 'PASSWORD_RESET',
            expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
          },
        })
        await sendMail({ to: user.email, ...passwordResetEmail(user.name, token) })
      }

      return { sent: true as const }
    },
    'If an account exists for that email, a reset link is on its way.',
  )
}

export async function resetPassword(input: unknown): Promise<ActionResult<{ email: string }>> {
  return runAction(
    resetPasswordSchema,
    input,
    async (data) => {
      await enforceRateLimit('passwordReset')

      const record = await prisma.verificationToken.findUnique({
        where: { tokenHash: hashToken(data.token) },
        include: { user: true },
      })

      if (
        !record ||
        record.purpose !== 'PASSWORD_RESET' ||
        record.usedAt ||
        record.expiresAt < new Date()
      ) {
        throw new AppError('This reset link is invalid or has expired', 400, 'INVALID_TOKEN')
      }

      const passwordHash = await hashPassword(data.password)
      await prisma.$transaction([
        prisma.user.update({
          where: { id: record.userId },
          data: { passwordHash, failedLogins: 0, lockedUntil: null },
        }),
        prisma.verificationToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() },
        }),
        // Any session opened with the old password is no longer trusted.
        prisma.session.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ])

      await audit({
        restaurantId: record.user.restaurantId,
        userId: record.userId,
        actorName: record.user.name,
        action: AUDIT_ACTIONS.PASSWORD_RESET,
        entity: 'User',
        entityId: record.userId,
      })

      return { email: record.user.email }
    },
    'Password updated. You can now sign in.',
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
        throw new UnauthorizedError('Your current password is incorrect')
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
