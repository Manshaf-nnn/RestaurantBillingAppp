import 'server-only'
import { redirect } from 'next/navigation'

import { ForbiddenError, UnauthorizedError } from '@/lib/errors'
import { can, canAny, type Permission } from '@/lib/rbac'
import { getCurrentUser, type AuthUser } from './session'

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

/** Platform operator — not bound to any restaurant. Used by the /admin console. */
export async function requireSuperAdmin(): Promise<AuthUser> {
  const user = await requireUser()
  if (user.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError('This area is restricted to platform administrators')
  }
  return user
}

export async function requirePageSuperAdmin(nextPath?: string): Promise<AuthUser> {
  const user = await requirePageUser(nextPath)
  if (user.role !== 'SUPER_ADMIN') redirect('/forbidden')
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

export async function requirePermission(permission: Permission): Promise<TenantUser> {
  const user = await requireTenantUser()
  if (!can(user, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`)
  }
  return user
}

export async function requireAnyPermission(permissions: Permission[]): Promise<TenantUser> {
  const user = await requireTenantUser()
  if (!canAny(user, permissions)) {
    throw new ForbiddenError('You do not have access to this area')
  }
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
