'use server'

import { cookies } from 'next/headers'

import { runSafe } from '@/lib/action'
import { ForbiddenError } from '@/lib/errors'
import { visibleBranchIds } from '@/lib/rbac'
import { BRANCH_COOKIE } from './selected-branch'
import { requireTenantUser } from '@/server/auth/guard'
import { markAllNotificationsRead, markNotificationRead } from '@/server/notifications'

export async function markAllRead() {
  return runSafe(async () => {
    const user = await requireTenantUser()
    const result = await markAllNotificationsRead(user.restaurantId, user.id)
    return { count: result.count }
  })
}

export async function markRead(id: string) {
  return runSafe(async () => {
    const user = await requireTenantUser()
    await markNotificationRead(id, user.restaurantId, user.id)
    return { id }
  })
}

/**
 * Remember which location the user last looked at.
 *
 * The URL remains the source of truth — see `selected-branch.ts` — and this only
 * records the choice so that opening the dashboard fresh lands where they left
 * off rather than on "all locations" every morning.
 *
 * Validated against what this user may see, so the cookie can never widen access
 * even if someone edits it by hand; `selectedBranch` re-checks on the way out
 * regardless.
 */
export async function rememberBranch(branchId: string | null) {
  return runSafe(async () => {
    const user = await requireTenantUser()
    const store = await cookies()

    if (!branchId) {
      store.delete(BRANCH_COOKIE)
      return { branchId: null }
    }

    const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
    if (allowed !== null && !allowed.includes(branchId)) {
      throw new ForbiddenError('You do not have access to that location')
    }

    store.set(BRANCH_COOKIE, branchId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })
    return { branchId }
  })
}
