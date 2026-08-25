import 'server-only'

import { redirect } from 'next/navigation'

import { PERMISSIONS, can } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { getApprovalPolicy } from '@/features/approvals/service'

/**
 * A till operator has to have a drawer open before they can work.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Cash taken with no session open carries `cashDrawerSessionId: null` and falls
 * outside every reconciliation there is — permanently, because nothing
 * back-fills it. It is money nobody can be asked about. The gate makes that
 * state unreachable for the people who take most of the cash.
 *
 * ── Who is gated, and who must not be ───────────────────────────────────────
 *
 *     CASH_DRAWER_OPERATE and not CASH_DRAWER_MANAGE
 *
 * That is exactly "somebody whose job is to run a till, and who is not a
 * manager". Owners, managers and admins hold MANAGE, so the gate can never lock
 * them out of their own dashboard — which is the failure mode that makes this
 * kind of interstitial dangerous. A custom role granted OPERATE alone is
 * gated, which is the right answer: it was granted a cashier's job.
 *
 * Gating on `role === 'CASHIER'` would have been simpler and wrong, because
 * this app's roles are templates and a restaurant can build a till-operating
 * role under any name.
 *
 * ── The escape hatch ────────────────────────────────────────────────────────
 *
 * `requireCashierSession` on the restaurant's policy turns it off. Default on,
 * because the reason it exists is real; switchable, because an operation that
 * takes no cash would otherwise face a locked door with nothing behind it, and
 * a support call is a worse answer than a setting.
 *
 * The session screen itself always shows a logout form, so nobody who cannot
 * open a drawer — no branch, no permission — is ever trapped there.
 */

export interface GateSubject {
  id: string
  restaurantId: string
  role: string
  permissions?: string[]
  rolePermissions?: string[] | null
}

/** Whether this person is subject to the gate at all. */
export function isTillOperator(user: {
  role: GateSubject['role']
  permissions?: string[]
  rolePermissions?: string[] | null
}): boolean {
  return (
    can(user as never, PERMISSIONS.CASH_DRAWER_OPERATE) &&
    !can(user as never, PERMISSIONS.CASH_DRAWER_MANAGE)
  )
}

/**
 * True when this person may proceed without seeing the session screen.
 *
 * Reads the drawer directly rather than going through `getOpenDrawer` so the
 * gate stays one indexed query — it runs on every cashier page load.
 */
export async function hasLiveSession(restaurantId: string, userId: string): Promise<boolean> {
  const open = await prisma.cashDrawerSession.findFirst({
    where: { restaurantId, openedById: userId, status: 'OPEN' },
    select: { id: true },
  })
  return Boolean(open)
}

/**
 * Send a till operator with no open drawer to the session screen.
 *
 * Call it from a page or a layout after the permission guard, and pass where
 * the person was heading so they land back there once the drawer is open.
 * Returns normally when there is nothing to do, which is the common case.
 */
export async function requireCashierSession(
  user: {
    id: string
    restaurantId: string
    role: GateSubject['role']
    permissions?: string[]
    rolePermissions?: string[] | null
  },
  next: string,
): Promise<void> {
  if (!isTillOperator(user)) return

  const policy = await getApprovalPolicy(user.restaurantId)
  if (!policy.requireCashierSession) return

  if (await hasLiveSession(user.restaurantId, user.id)) return

  redirect(`/cashier/session?next=${encodeURIComponent(next)}`)
}
