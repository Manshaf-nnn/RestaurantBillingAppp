import 'server-only'
import { redirect } from 'next/navigation'

import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors'
import { can, canAny, canAccessBranch, type Permission } from '@/lib/rbac'
import { TOUCH_EVERY_MS, touchShift } from '@/features/attendance/service'
import { getAdminUser, getCurrentUser, type AuthUser } from './session'
import { due } from './presence'

/**
 * Guards used by every server action, route handler and protected page.
 * These throw (API surfaces) or redirect (pages) — there is no code path where
 * a caller can accidentally proceed unauthenticated.
 */

export interface TenantUser extends AuthUser {
  restaurantId: string
}

export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser()
  if (!user) throw new UnauthorizedError()
  return user
}

/**
 * Platform operator — reads the SEPARATE admin session, so it is independent of
 * any restaurant login in the same browser.
 */
export async function requireSuperAdmin(): Promise<AuthUser> {
  const user = await getAdminUser()
  if (!user) throw new UnauthorizedError()
  if (user.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError('This area is restricted to platform administrators')
  }
  return user
}

export async function requirePageSuperAdmin(nextPath?: string): Promise<AuthUser> {
  const user = await getAdminUser()
  if (!user || user.role !== 'SUPER_ADMIN') {
    redirect(nextPath ? `/admin/login?next=${encodeURIComponent(nextPath)}` : '/admin/login')
  }
  return user
}

/** A staff member bound to a restaurant — the normal case for all tenant data. */
export async function requireTenantUser(): Promise<TenantUser> {
  const user = await requireUser()
  if (!user.restaurantId) {
    throw new ForbiddenError('This account is not linked to a restaurant')
  }
  return user as TenantUser
}

/**
 * Refuse an action aimed at a location this user may not touch.
 *
 * Permissions answer "may they do this at all", never "may they do it *there*".
 * A warehouse assistant tied to Colombo held INVENTORY_MANAGE and could waste,
 * adjust or dispatch Kandy's stock simply by posting Kandy's id — the actions
 * checked the restaurant and the permission and nothing else. `canAccessBranch`
 * existed for exactly this and had no callers anywhere in the codebase.
 *
 * Call it in every action that takes a branch id from the client. A null id
 * means "wherever this user belongs" and is always allowed; the caller resolves
 * it afterwards.
 */
export async function assertBranchAccess(
  user: TenantUser,
  branchId: string | null | undefined,
): Promise<void> {
  if (!branchId) return
  if (!canAccessBranch({ role: user.role, branchId: user.branchId }, branchId)) {
    throw new ForbiddenError('You do not have access to that location')
  }
}

/**
 * Record that this person is working, if a shift of theirs is open.
 *
 * ── Why here, of all places ─────────────────────────────────────────────────
 *
 * A shift's hours end at the last thing somebody DID, and this is the one line
 * every "doing something" passes through. The guards divide cleanly:
 * `requirePermission` gates server actions — the writes — while pages go through
 * `requirePageUser` and `/api/pulse` calls neither. So a page render costs
 * nothing, the pulse poll that every station fires continuously costs nothing,
 * and a wall-mounted kitchen display left on overnight cannot claim a twelve
 * hour shift. Presence is not work; this hook is what keeps the two apart.
 *
 * `audit()` was the obvious alternative and it is the wrong one: it does not
 * cover `updateItemStatus`, which writes no audit row and is the single most
 * repeated action in a kitchen. A cook who preps two hundred items would have
 * shown a nought-minute shift.
 *
 * Throttled to a minute per person, and deliberately not awaited — one indexed
 * single-row UPDATE that nobody is waiting on. If it fails, somebody's
 * timesheet is a minute out; if it were allowed to throw, an order would fail.
 */
function markWorking(user: TenantUser): void {
  if (!due(`shift:${user.id}`, TOUCH_EVERY_MS)) return
  touchShift(user.id).catch(() => {})
}

export async function requirePermission(permission: Permission): Promise<TenantUser> {
  const user = await requireTenantUser()
  if (!can(user, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`)
  }
  markWorking(user)
  return user
}

export async function requireAnyPermission(permissions: Permission[]): Promise<TenantUser> {
  const user = await requireTenantUser()
  if (!canAny(user, permissions)) {
    throw new ForbiddenError('You do not have access to this area')
  }
  markWorking(user)
  return user
}

/** Page-level guard: sends visitors to the login screen instead of throwing. */
export async function requirePageUser(nextPath?: string): Promise<AuthUser> {
  const user = await getCurrentUser()
  if (!user) {
    redirect(nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : '/login')
  }
  return user
}

export async function requirePagePermission(
  permission: Permission,
  nextPath?: string,
): Promise<TenantUser> {
  const user = await requirePageUser(nextPath)
  if (!user.restaurantId) redirect('/onboarding')
  if (!can(user, permission)) redirect('/forbidden')
  return user as TenantUser
}

export async function requirePageAnyPermission(
  permissions: Permission[],
  nextPath?: string,
): Promise<TenantUser> {
  const user = await requirePageUser(nextPath)
  if (!user.restaurantId) redirect('/onboarding')
  if (!canAny(user, permissions)) redirect('/forbidden')
  return user as TenantUser
}

/**
 * Refuse a record that belongs to a branch this person cannot see.
 *
 * The distinction from `assertBranchAccess` is the whole point: that one checks
 * a branch id *the caller sent*, which protects the destination of a write and
 * nothing else. This checks the branch of a record *already in the database*,
 * which is what stops a Kandy manager approving a Colombo purchase order by
 * pasting its id.
 *
 * The audit that prompted this found the payload-only pattern in four
 * purchasing actions: omit the optional `branchId` and `assertBranchAccess`
 * returns immediately on its `if (!branchId) return`, so the guard passed while
 * checking nothing. `production/actions.ts` already had the right shape — read
 * the record's own branch, then assert — and this makes it reusable.
 *
 * A null branch on the record means "not branch-scoped" and is allowed: a
 * supplier and a customer belong to the restaurant, not to a site.
 */
export async function assertRecordBranch(
  user: TenantUser,
  record: { branchId: string | null } | null,
  what = 'record',
): Promise<void> {
  if (!record) throw new NotFoundError(what)
  if (!record.branchId) return
  if (!canAccessBranch({ role: user.role, branchId: user.branchId }, record.branchId)) {
    throw new ForbiddenError(`That ${what} belongs to another location`)
  }
}
