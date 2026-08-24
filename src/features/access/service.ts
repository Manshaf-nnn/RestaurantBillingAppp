import 'server-only'

import type { UserRole } from '@prisma/client'

import { ForbiddenError, NotFoundError } from '@/lib/errors'
import {
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  permissionsFor,
  requiresOwnBranch,
  seesAllLocations,
  visibleBranchIds,
  type Permission,
} from '@/lib/rbac'
import type { TenantUser } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

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
  const reach = visibleBranchIds({ role: admin.role, branchId: admin.branchId })

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
  const reach = visibleBranchIds({ role: admin.role, branchId: admin.branchId })
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
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  })

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
