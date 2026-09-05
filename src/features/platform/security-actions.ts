'use server'

import { revalidatePath } from 'next/cache'
import QRCode from 'qrcode'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { AppError } from '@/lib/errors'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requireSuperAdmin } from '@/server/auth/guard'
import { confirmEnrolment, startEnrolment, verifySecondFactor } from '@/server/auth/mfa'
import { prisma } from '@/server/db/prisma'

/**
 * Two-factor enrolment for the operator's own account (athu.md).
 *
 * The TOTP implementation in `server/auth/mfa.ts` was complete, tested against
 * the RFC vector, and had no callers — the security page reported "MFA
 * coverage" for a control nobody could switch on. These three actions are the
 * missing surface. Each acts on the SIGNED-IN super admin only: there is no
 * "enrol this other user" here, because a second factor somebody else set up
 * for you is not a second factor.
 *
 * Enforcement at sign-in lives in `features/auth/mfa-gate.ts` and keys on
 * `mfaEnabledAt`, so the moment `confirmMfaEnrolment` succeeds the next sign-in
 * asks for a code.
 */

const codeSchema = z.object({
  code: z.string().trim().min(6, 'Enter the code').max(16),
})

export type EnrolmentStart = {
  /** The secret, for typing into an app that cannot scan. */
  secret: string
  /** A data: URL of the QR code — nothing is fetched from anywhere. */
  qrDataUrl: string
}

/**
 * Step one: mint a secret and show the QR.
 *
 * Refused while MFA is ON. `startEnrolment` replaces the secret and clears
 * `mfaEnabledAt`, so calling it on an enrolled account would silently switch
 * the second factor off — the one thing a button on a security page must never
 * do by accident. Turn it off first, with a code.
 */
export async function startMfaEnrolment(): Promise<ActionResult<EnrolmentStart>> {
  return runAction(z.object({}), {}, async () => {
    const admin = await requireSuperAdmin()

    const current = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
      select: { mfaEnabledAt: true },
    })
    if (current.mfaEnabledAt) {
      throw new AppError(
        'Two-factor authentication is already on. Turn it off before setting it up again.',
        409,
        'MFA_ALREADY_ENABLED',
      )
    }

    const enrolment = await startEnrolment({ userId: admin.id, email: admin.email })
    const qrDataUrl = await QRCode.toDataURL(enrolment.otpauthUrl, { margin: 1, width: 224 })
    return { secret: enrolment.secret, qrDataUrl }
  })
}

/**
 * Step two: prove the app produces the right code, and receive the recovery
 * codes. They are shown once — only their hashes are stored.
 */
export async function confirmMfaEnrolment(
  input: unknown,
): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return runAction(codeSchema, input, async (data) => {
    const admin = await requireSuperAdmin()
    const { recoveryCodes } = await confirmEnrolment({ userId: admin.id, code: data.code })

    await audit({
      userId: admin.id,
      actorName: admin.name,
      action: AUDIT_ACTIONS.MFA_ENABLED,
      entity: 'User',
      entityId: admin.id,
    })

    revalidatePath('/admin/security')
    return { recoveryCodes }
  }, 'Two-factor authentication is on.')
}

/**
 * Switch the second factor off — with a current code, so a stolen live session
 * cannot remove the control that would have stopped the theft being useful.
 */
export async function disableMfa(input: unknown): Promise<ActionResult<{ disabled: true }>> {
  return runAction(codeSchema, input, async (data) => {
    const admin = await requireSuperAdmin()

    const check = await verifySecondFactor({ userId: admin.id, code: data.code })
    if (!check.ok) {
      throw new AppError('That code is not right — check the clock on your phone', 401, 'MFA_BAD_CODE')
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: admin.id },
        data: { mfaSecret: null, mfaEnabledAt: null },
      })
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: admin.id } })
    })

    await audit({
      userId: admin.id,
      actorName: admin.name,
      action: AUDIT_ACTIONS.MFA_DISABLED,
      entity: 'User',
      entityId: admin.id,
      after: { usedRecoveryCode: check.usedRecoveryCode },
    })

    revalidatePath('/admin/security')
    return { disabled: true as const }
  }, 'Two-factor authentication is off.')
}
