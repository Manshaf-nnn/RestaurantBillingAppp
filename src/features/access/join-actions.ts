'use server'

import { redirect } from 'next/navigation'

import { runAction, type ActionResult } from '@/lib/action'
import { UnauthorizedError } from '@/lib/errors'
import { landingFor, resolveLink, stampUse } from './links'
import { joinSchema } from './link-schema'
import { createSession } from '@/server/auth/session'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { enforceRateLimit } from '@/server/security/rate-limit'
import { nextStaffCode } from '@/features/staff/codes'
import { generateToken, hashPassword, verifyPassword } from '@/server/auth/password'
import { prisma } from '@/server/db/prisma'

/**
 * Signing in through an access link.
 *
 * ── Personal ────────────────────────────────────────────────────────────────
 *
 * The flow Rolelogic §6 describes: the link opens a login that already knows
 * the role and branch, and the person supplies their email and code. The link
 * on its own is worth nothing, so forwarding the message does not forward the
 * access.
 *
 * The code IS the password (`staff/codes.ts` writes `signInCode` and
 * `passwordHash` together), so this checks the same hash the ordinary login
 * checks. No second credential path, and nothing to keep in step.
 *
 * ── Shared device ───────────────────────────────────────────────────────────
 *
 * The kitchen tablet. Opening the URL signs the device in, as it always did —
 * but the account it creates now carries the link's branch and role, which is
 * what stops it landing on a screen that is empty for ever.
 */

/**
 * The code as it was stored.
 *
 * `issueSignInCode` writes it grouped — `A7K2-M9PX` — and hashes that exact
 * string, so a comparison has to match the grouping. People retype it from a
 * printed card without the dash about as often as with it, and in lower case
 * more often than not, so both are accepted rather than rejected as a wrong
 * code. Nothing is lost: the alphabet has no lowercase letters and no dashes
 * of its own, so the normalisation cannot turn one valid code into another.
 */
function normaliseCode(input: string): string {
  const bare = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : input.trim().toUpperCase()
}

/** Rate-limited on the login bucket: a token is a credential like any other. */
export async function joinWithCode(input: unknown): Promise<ActionResult<never>> {
  return runAction(joinSchema, input, async (data) => {
    await enforceRateLimit('login')

    const link = await resolveLink(data.token)
    if (link.mode !== 'PERSONAL') throw new UnauthorizedError('This link does not take a code')

    const person = await prisma.user.findFirst({
      where: { id: link.userId ?? '', restaurantId: link.restaurantId, deletedAt: null },
      // `name`, `restaurantId` and `branchId` are for the login audit row below.
      select: {
        id: true, email: true, passwordHash: true, isActive: true, role: true,
        name: true, restaurantId: true, branchId: true,
      },
    })

    /*
     * One message for every failure, and the hash is verified even when there
     * is nobody to verify it against.
     *
     * Telling somebody "wrong code" rather than "wrong email" confirms which
     * half they got right, and returning early on a missing user answers
     * measurably faster than a real bcrypt comparison — both hand an attacker
     * a way to enumerate. The ordinary login already does this dummy-compare
     * dance for the same reason.
     */
    const supplied = normaliseCode(data.code)
    const emailMatches =
      person !== null && person.email.toLowerCase() === data.email.trim().toLowerCase()
    const hash = person?.passwordHash ?? (await hashPassword(generateToken(12)))
    const codeMatches = await verifyPassword(supplied, hash)

    if (!person || !person.isActive || !emailMatches || !codeMatches) {
      throw new UnauthorizedError('That email and code do not match this link')
    }

    /*
     * The link decides where they work and what they may do.
     *
     * Applied on every sign-in rather than only the first, so moving a link to
     * another branch moves the person with it. It is the owner's statement of
     * where this link leads, and it should not be possible for a stale value
     * on the account to outrank it.
     *
     * ── The role is written too, and derived rather than trusted ────────────
     *
     * It was not written at all, which is what produced "you do not have
     * access here": the link redirected to its own role's landing page while
     * the account — and therefore the JWT the edge middleware reads — still
     * said something else.
     *
     * `staffRolePreset` and not `link.role`, because a link is applied on
     * every sign-in and `link.role` is a value frozen when it was created. An
     * owner who promotes somebody in Staff and then watches them sign in
     * through an older link would otherwise see them silently demoted back.
     * The custom role is the live statement; where there is none, the account
     * keeps the role it has.
     */
    const nextRole = link.staffRolePreset

    await prisma.user.update({
      where: { id: person.id },
      data: {
        ...(link.branchId ? { branchId: link.branchId } : {}),
        ...(link.staffRoleId ? { staffRoleId: link.staffRoleId } : {}),
        ...(nextRole ? { role: nextRole } : {}),
      },
    })

    await createSession(person.id)
    await stampUse(link.id)

    /*
     * A sign-in by link is a sign-in.
     *
     * The password path has always written this row and this one never did, so
     * the login history simply omitted everybody who joins through a link —
     * which, for a restaurant that hands out access links to its floor staff,
     * is most of the team. It is also the row the staff activity feed reads to
     * show that somebody arrived.
     */
    await audit({
      restaurantId: person.restaurantId,
      branchId: link.branchId ?? person.branchId ?? null,
      userId: person.id,
      actorName: person.name,
      action: AUDIT_ACTIONS.LOGIN,
      entity: 'User',
      entityId: person.id,
      after: { via: 'access-link' },
    })

    // Where the account can actually go, not where the link was minted for.
    redirect(landingFor(nextRole ?? person.role))
  })
}

/**
 * Open a shared-device link.
 *
 * Deliberately not single-use: a screen on a wall reopens it after every
 * reboot. The link is therefore the credential and has to be treated like one
 * — hence the rate limit, the expiry, and the ability to revoke it.
 */
export async function joinAsDevice(input: unknown): Promise<ActionResult<never>> {
  return runAction(joinSchema.pick({ token: true }), input, async (data) => {
    await enforceRateLimit('login')

    const link = await resolveLink(data.token)
    if (link.mode !== 'SHARED_DEVICE') {
      throw new UnauthorizedError('This link needs an email and code')
    }

    /*
     * One account per link, reused. Keyed on the invite id rather than the
     * token, so regenerating a leaked link keeps the same device account and
     * everything it has already served stays attributed to it.
     */
    /*
     * The custom role's base wins here too, so a device link and a personal
     * link built on the same role produce accounts that behave identically.
     */
    const deviceRole = link.staffRolePreset ?? link.role

    const email = `device+${link.id}@invites.local`
    let user = await prisma.user.findFirst({
      where: { email, restaurantId: link.restaurantId },
      select: { id: true, isActive: true, deletedAt: true },
    })

    if (!user) {
      const created = await prisma.user.create({
        data: {
          email,
          passwordHash: await hashPassword(generateToken(12)),
          name: link.staffRoleName
            ? `${link.staffRoleName} (shared screen)`
            : `${link.roleLabel} (shared screen)`,
          role: deviceRole,
          restaurantId: link.restaurantId,
          branchId: link.branchId,
          staffRoleId: link.staffRoleId,
          isActive: true,
          // Without a code this screen's orders are unattributable, and "who
          // served table 4" is the whole point of staff codes.
          staffCode: await nextStaffCode(prisma, link.restaurantId),
        },
        select: { id: true, isActive: true, deletedAt: true },
      })
      user = created
    } else {
      // The link is the authority on all three, every time — see joinWithCode.
      // A device account exists only to serve this link, so unlike a personal
      // one there is no separately-managed role that could be clobbered.
      await prisma.user.update({
        where: { id: user.id },
        data: { branchId: link.branchId, staffRoleId: link.staffRoleId, role: deviceRole },
      })
    }

    if (!user.isActive || user.deletedAt) {
      throw new UnauthorizedError('This link has been disabled')
    }

    await createSession(user.id)
    await stampUse(link.id)

    redirect(landingFor(deviceRole))
  })
}
