import 'server-only'

import type { UserRole } from '@prisma/client'

import { ForbiddenError, NotFoundError } from '@/lib/errors'
import {
  ROLE_LABELS,
  assignableRoles,
  ROLE_PERMISSIONS,
  permissionsFor,
  requiresOwnBranch,
  seesAllLocations,
  visibleBranchIds,
  type Permission,
} from '@/lib/rbac'
import type { TenantUser } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { generateToken } from '@/server/auth/password'
import { tenantOrigin } from '@/lib/tenant-url'
import { joinUrl } from './links'

export interface RoleSummary {
  id: string
  name: string
  description: string | null
  preset: UserRole
  presetLabel: string
  branchId: string | null
  branchName: string | null
  permissions: string[]
  isActive: boolean
  memberCount: number
  createdAt: string
  /**
   * The sign-in link for everybody on this role (sidebar.md — role links).
   *
   * Null when the role has none. On the card it is a URL to copy; opening it
   * asks for the member's own email and code and refuses anybody not on the
   * role, so it is shareable in a way a password never is.
   */
  signInUrl: string | null
}

/**
 * Nobody may build a role more powerful than themselves.
 *
 * ── Why this is the load-bearing check in the whole feature ─────────────────
 *
 * Creating roles is `STAFF_MANAGE`, which every MANAGER holds. Without this,
 * a manager could save a role called "Assistant" carrying `settings.manage`
 * and `payment.refund`, assign it to an account they control, sign in and hold
 * powers their own account never had. That is privilege escalation with extra
 * steps, and it is the obvious way to attack a system that lets people define
 * their own permission sets.
 *
 * `assignableRoles` already stops somebody minting their own RANK. This is the
 * same idea applied to the permission list, because a custom role is a rank
 * somebody wrote down themselves.
 *
 * An owner passes trivially — `permissionsFor` gives them everything — so the
 * check costs nothing in the ordinary case and only bites where it should.
 */
export function assertNoEscalation(admin: TenantUser, permissions: string[]): void {
  const held = permissionsFor(admin)
  const beyond = permissions.filter((p) => !held.has(p))
  if (beyond.length === 0) return
  throw new ForbiddenError(
    `You cannot grant what you do not have: ${beyond.slice(0, 3).join(', ')}` +
      (beyond.length > 3 ? ` and ${beyond.length - 3} more` : ''),
  )
}

/**
 * The location a role pins its members to.
 *
 * Deliberately the same shape as `homeBranchFor` in `features/staff/actions.ts`
 * and for the same two reasons, because a role assigns reach exactly as adding
 * a person does:
 *
 *   1. A preset that `requiresOwnBranch` — kitchen, cashier, waiter — must
 *      have one. `visibleBranchIds` returns `[]` for them without it, so the
 *      role would produce accounts whose every screen is empty with nothing to
 *      say why.
 *   2. "Every location" is only somebody's to grant if they have every
 *      location. Otherwise a manager confined to Kandy could define a role
 *      with no branch and hand out sight of the whole group.
 */
export async function resolveRoleBranch(
  admin: TenantUser,
  branchId: string | null | undefined,
  preset: UserRole,
): Promise<string | null> {
  const reach = visibleBranchIds(admin)

  if (!branchId) {
    if (requiresOwnBranch(preset)) {
      throw new ForbiddenError(
        `A role based on ${ROLE_LABELS[preset]} must be given a location — without one its members see nothing at all.`,
      )
    }
    if (reach === null) return null
    throw new ForbiddenError(
      'You can only create roles for your own location — leave it blank only if you oversee all of them',
    )
  }

  if (reach !== null && !reach.includes(branchId)) {
    throw new ForbiddenError('You do not have access to that location')
  }

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, restaurantId: admin.restaurantId, deletedAt: null },
    select: { id: true },
  })
  if (!branch) throw new NotFoundError('Location')
  return branch.id
}

/**
 * Rank is not reach.
 *
 * The same gap `assertScopeAllowed` closes on the staff form: ACCOUNTANT and
 * INVENTORY_MANAGER are assignable by a site manager AND are cross-location,
 * so basing a role on one would grant sight of every branch to somebody
 * created by a person confined to a single site.
 */
export function assertPresetScopeAllowed(admin: TenantUser, preset: UserRole): void {
  const reach = visibleBranchIds(admin)
  if (reach === null) return
  // MANAGER is confined the moment it is given a branch, and `resolveRoleBranch`
  // guarantees a confined admin gives one, so it is safe here.
  if (preset !== 'MANAGER' && seesAllLocations(preset, null)) {
    throw new ForbiddenError(
      `You cannot base a role on ${ROLE_LABELS[preset]} — that role sees every location and you do not`,
    )
  }
}

/** The role, confirmed to belong to this restaurant. */
export async function requireRole(restaurantId: string, id: string) {
  const role = await prisma.staffRole.findFirst({
    where: { id, restaurantId, deletedAt: null },
  })
  if (!role) throw new NotFoundError('Role')
  return role
}

export async function listRoles(
  restaurantId: string,
  branchIds: string[] | null,
): Promise<RoleSummary[]> {
  /*
   * A confined admin sees the roles for their own location, plus the
   * unpinned ones which apply everywhere. `branchIds` of `[]` — confined with
   * nowhere to look — must match nothing rather than everything, which is why
   * the `in` clause is built from the list rather than skipped when it is
   * empty.
   */
  const scope =
    branchIds === null ? {} : { OR: [{ branchId: { in: branchIds } }, { branchId: null }] }

  const roles = await prisma.staffRole.findMany({
    where: { restaurantId, deletedAt: null, ...scope },
    include: {
      branch: { select: { name: true } },
      _count: { select: { members: true } },
      /*
       * The role's own sign-in link. At most one is ever live per role — the
       * action below reuses rather than mints — so taking the newest active
       * one is taking the one.
       */
      invites: {
        where: { mode: 'ROLE', isActive: true },
        select: { token: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  })

  // One read for the whole list, so the origin is not re-derived per row.
  const home = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { customDomain: true, customDomainVerifiedAt: true },
  })
  const origin = tenantOrigin(home)

  return roles.map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    preset: role.preset,
    presetLabel: ROLE_LABELS[role.preset],
    branchId: role.branchId,
    branchName: role.branch?.name ?? null,
    permissions: role.permissions,
    isActive: role.isActive,
    memberCount: role._count.members,
    createdAt: role.createdAt.toISOString(),
    signInUrl: role.invites[0] ? joinUrl(role.invites[0].token, origin) : null,
  }))
}

/**
 * The permission list a built-in role starts with.
 *
 * What "duplicate a predefined role as a template" copies. Narrowed to what
 * the person doing the copying actually holds, so cloning Administrator as a
 * manager gives a manager's version of it rather than being refused outright —
 * the useful behaviour, and safe because the narrowing happens before the row
 * is written rather than being trusted from the form.
 */
export function templateFor(admin: TenantUser, preset: UserRole): string[] {
  const held = permissionsFor(admin)
  return (ROLE_PERMISSIONS[preset] as Permission[]).filter((p) => held.has(p))
}

/**
 * The sign-in link that belongs to a role (sidebar.md — role links).
 *
 * Lives here rather than in `link-actions.ts` because two callers need it and
 * a `'use server'` module cannot export a plain helper: `createRole` mints one
 * with every new role, and `roleSignInLink` makes one for the roles that
 * already existed.
 *
 * ── One live link per role ──────────────────────────────────────────────────
 *
 * Reused, never duplicated. A second valid URL for one role is a credential
 * nobody knows exists, and revoking the first would do nothing about it.
 * Rotating is a separate, deliberate act on the Links screen.
 *
 * ── The guards are the role builder's own ───────────────────────────────────
 *
 * Rank, escalation and branch, checked against the ADMIN minting it — because
 * a link is an account: walking through one produces a session, so it can only
 * ever hand out something its maker could hand out directly.
 */
export async function mintRoleLink(
  admin: TenantUser,
  staffRoleId: string,
): Promise<{ url: string; created: boolean }> {
  const role = await requireRole(admin.restaurantId, staffRoleId)

  const home = await prisma.restaurant.findUnique({
    where: { id: admin.restaurantId },
    select: { customDomain: true, customDomainVerifiedAt: true },
  })
  const origin = tenantOrigin(home)

  const existing = await prisma.invite.findFirst({
    where: {
      restaurantId: admin.restaurantId,
      staffRoleId: role.id,
      mode: 'ROLE',
      isActive: true,
    },
    orderBy: { createdAt: 'desc' },
    select: { token: true },
  })
  if (existing) return { url: joinUrl(existing.token, origin), created: false }

  if (!assignableRoles(admin.role).includes(role.preset)) {
    throw new ForbiddenError(`You cannot create a link for the ${ROLE_LABELS[role.preset]} role`)
  }
  if (!role.isActive) throw new ForbiddenError('That role is switched off')
  // Handing out a role is granting it.
  assertNoEscalation(admin, role.permissions)
  const branchId = await resolveRoleBranch(admin, role.branchId, role.preset)

  const link = await prisma.invite.create({
    data: {
      token: generateToken(24),
      restaurantId: admin.restaurantId,
      role: role.preset,
      mode: 'ROLE',
      branchId,
      staffRoleId: role.id,
      // No `userId`: that is the whole difference from a personal link. This
      // one admits whoever proves they are on the role.
      userId: null,
      label: role.name,
      /*
       * No expiry. A role link is a fixture — pinned up in a staff room, saved
       * to a home screen — and one that dies in thirty days dies mid-shift
       * with nobody around to reissue it. Switching the role off closes it,
       * and it can be rotated on demand.
       */
      expiresAt: null,
      createdById: admin.id,
    },
    select: { token: true },
  })

  return { url: joinUrl(link.token, origin), created: true }
}
