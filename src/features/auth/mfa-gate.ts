import 'server-only'

import { mfaRequired, verifySecondFactor } from '@/server/auth/mfa'

/**
 * The second-factor decision at sign-in, separated from the request so it can
 * be tested without one (athu.md).
 *
 * ── Why it gates on enrolment, not on role ──────────────────────────────────
 *
 * The spec asks for stronger controls on the platform admin, and the admin is
 * covered by construction — enrolment is offered on the admin security page.
 * But the gate reads `mfaEnabledAt`, not `role`, on purpose: enrolment is a
 * promise the application makes to whoever enrols, and an owner who sets up an
 * authenticator and is then never asked for the code has been handed a control
 * that does nothing — the same defect as a "Remember me" box nobody reads.
 * Nobody who has NOT enrolled sees any change.
 *
 * ── Stateless on purpose ────────────────────────────────────────────────────
 *
 * There is no "password verified, code pending" cookie. The client simply
 * resubmits email, password AND code, and the password is verified again
 * (~100 ms of bcrypt). That is one fewer secret-bearing cookie, no five-minute
 * expiry to get wrong on a serverless host, and the existing per-IP/per-email
 * login limiter already covers both steps. The only state is the account's own
 * enrolment.
 */

export type SecondFactorOutcome =
  /** No second factor enrolled — the password alone signs this account in. */
  | { outcome: 'not-enrolled' }
  /** Enrolled, and no code was sent: ask for one. Nothing has been issued. */
  | { outcome: 'code-required' }
  /** Enrolled, and the code checks out. */
  | { outcome: 'ok'; usedRecoveryCode: boolean }
  /** Enrolled, and the code does not. Counts as a failed login attempt. */
  | { outcome: 'bad-code' }

export async function secondFactorGate(params: {
  userId: string
  code?: string | null
}): Promise<SecondFactorOutcome> {
  if (!(await mfaRequired(params.userId))) return { outcome: 'not-enrolled' }

  const code = params.code?.trim()
  if (!code) return { outcome: 'code-required' }

  const result = await verifySecondFactor({ userId: params.userId, code })
  return result.ok ? { outcome: 'ok', usedRecoveryCode: result.usedRecoveryCode } : { outcome: 'bad-code' }
}
