import 'server-only'

import type { InviteMode, UserRole } from '@prisma/client'

import { ForbiddenError, NotFoundError } from '@/lib/errors'
import { landingFor, ROLE_LABELS } from '@/lib/rbac'
import { appUrl } from '@/lib/env'
import { tenantOrigin } from '@/lib/tenant-url'
import { prisma } from '@/server/db/prisma'

/**
 * Access links: one URL that gets somebody into their workspace.
 *
 * ── Two modes, because there are two situations ─────────────────────────────
 *
 * The link used to be the credential. Opening the URL signed you straight in
 * as a shared account named "WAITER (shared link)" — no email, no code — and
 * the account it made had no branch at all, so `visibleBranchIds` returned `[]`
 * and every screen was empty for ever with nothing to say why.
 *
 * That behaviour is right for exactly one thing: a screen bolted to a wall. A
 * kitchen tablet reboots and has to come back up without somebody typing a
 * code, and Rolelogic's own flow does not cover it. So it survives as
 * SHARED_DEVICE, with the branch and role it was always missing.
 *
 * Everything else is PERSONAL: the link opens a login scoped to its role and
 * branch, and the person enters their email and code. The link on its own is
 * then worth nothing — forwarding the message does not forward the access,
 * which is the property a shared-device link cannot have.
 *
 * ── The token ───────────────────────────────────────────────────────────────
 *
 * 24 bytes from `generateToken`, so 192 bits — not guessable. Stored in plain
 * text, deliberately, and worth being straight about: a database leak exposes
 * working links. The same is true of `signInCode`, and for the same reason —
 * the owner has to be able to re-copy the link, and the secret is already in
 * the holder's pocket. Both are revocable, both expire, and both sit behind
 * the login rate limiter.
 */

export interface AccessLink {
  id: string
  label: string | null
  mode: InviteMode
  role: UserRole
  roleLabel: string
  staffRoleId: string | null
  staffRoleName: string | null
  branchId: string | null
  branchName: string | null
  userId: string | null
  userName: string | null
  userEmail: string | null
  /** Readable by the owner so a lost card can be reprinted. */
  signInCode: string | null
  url: string
  isActive: boolean
  expiresAt: string | null
  expired: boolean
  lastUsedAt: string | null
  useCount: number
  createdAt: string
}

/**
 * The canonical URL for a link. One place, so the callers cannot drift.
 *
 * Takes the restaurant's own origin where there is one: these get printed on
 * cards and taped to walls, and a card naming the platform address sends
 * somebody to a hostname where their session will not exist. Defaults to the
 * platform address, which is right for a restaurant with no domain of its own.
 */
export function joinUrl(token: string, origin: string = appUrl()): string {
  return `${origin}/join/${token}`
}

/*
 * Where somebody lands once the link has let them in — `lib/rbac.ts`, not a
 * second copy. Re-exported so existing importers of this module keep working.
 */
export { landingFor }

export async function listAccessLinks(
  restaurantId: string,
  branchIds: string[] | null,
): Promise<AccessLink[]> {
  /*
   * A confined admin sees their own location's links plus the unpinned ones.
   * `[]` — confined with nowhere to look — must match nothing, which is why
   * the `in` is built from the list rather than skipped when it is empty.
   */
  const scope =
    branchIds === null ? {} : { OR: [{ branchId: { in: branchIds } }, { branchId: null }] }

  const home = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { customDomain: true, customDomainVerifiedAt: true },
  })
  const origin = tenantOrigin(home)

  const rows = await prisma.invite.findMany({
    where: { restaurantId, ...scope },
    include: {
      branch: { select: { name: true } },
      staffRole: { select: { name: true } },
      user: { select: { name: true, email: true, signInCode: true } },
    },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  })

  const now = new Date()
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    mode: row.mode,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role],
    staffRoleId: row.staffRoleId,
    staffRoleName: row.staffRole?.name ?? null,
    branchId: row.branchId,
    branchName: row.branch?.name ?? null,
    userId: row.userId,
    userName: row.user?.name ?? null,
    userEmail: row.user?.email ?? null,
    signInCode: row.user?.signInCode ?? null,
    url: joinUrl(row.token, origin),
    isActive: row.isActive,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    expired: Boolean(row.expiresAt && row.expiresAt < now),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    useCount: row.useCount,
    createdAt: row.createdAt.toISOString(),
  }))
}

export interface ResolvedLink {
  id: string
  mode: InviteMode
  role: UserRole
  roleLabel: string
  restaurantId: string
  restaurantName: string
  branchId: string | null
  branchName: string | null
  staffRoleId: string | null
  staffRoleName: string | null
  /** The base role the custom role is built on — what the account becomes. */
  staffRolePreset: UserRole | null
  userId: string | null
  userEmail: string | null
  token: string
}

/**
 * Turn a token into a usable link, or refuse it.
 *
 * Every reason to refuse is the same message to the visitor. A link that says
 * "expired" versus "revoked" versus "no such link" tells somebody holding a
 * guessed token which of their guesses was closest, and the distinction is
 * worth nothing to the person who was legitimately sent it.
 */
export async function resolveLink(token: string): Promise<ResolvedLink> {
  const invite = await prisma.invite.findUnique({
    where: { token },
    include: {
      branch: { select: { id: true, name: true } },
      staffRole: { select: { id: true, name: true, isActive: true, preset: true } },
      user: { select: { id: true, email: true, isActive: true, deletedAt: true } },
      restaurant: { select: { id: true, name: true, status: true, isActive: true } },
    },
  })

  const dead = new NotFoundError('This link is not valid any more')

  if (!invite || !invite.isActive) throw dead
  if (invite.expiresAt && invite.expiresAt < new Date()) throw dead

  // A suspended tenant would hand out a session that every page then bounces.
  if (
    !invite.restaurant ||
    invite.restaurant.status !== 'ACTIVE' ||
    !invite.restaurant.isActive
  ) {
    throw new ForbiddenError('This restaurant is not active')
  }

  // A personal link whose person is gone or switched off is a dead link, not
  // an invitation to create a new account.
  if (invite.mode === 'PERSONAL') {
    if (!invite.user || !invite.user.isActive || invite.user.deletedAt) throw dead
  }

  return {
    id: invite.id,
    mode: invite.mode,
    role: invite.role,
    roleLabel: ROLE_LABELS[invite.role],
    restaurantId: invite.restaurantId,
    restaurantName: invite.restaurant.name,
    branchId: invite.branch?.id ?? null,
    branchName: invite.branch?.name ?? null,
    // A switched-off role must not be silently applied; the member falls back
    // to the preset, exactly as `activeRolePermissions` does in the session.
    staffRoleId: invite.staffRole?.isActive ? invite.staffRole.id : null,
    staffRoleName: invite.staffRole?.isActive ? invite.staffRole.name : null,
    staffRolePreset: invite.staffRole?.isActive ? invite.staffRole.preset : null,
    userId: invite.user?.id ?? null,
    userEmail: invite.user?.email ?? null,
    token,
  }
}

/** Record that a link was walked through, so an unused one is visible as such. */
export async function stampUse(id: string): Promise<void> {
  await prisma.invite
    .update({
      where: { id },
      data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
    })
    .catch(() => undefined)
}
