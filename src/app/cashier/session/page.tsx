import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { SessionStart } from '@/features/cashdrawer/components/session-start'
import { hasLiveSession } from '@/features/cashdrawer/gate'
import { listRegistersForBranches } from '@/features/cashdrawer/registers'
import { listPendingForUser } from '@/features/handover/cash-service'
import { listStationBranches } from '@/features/dashboard/selected-branch'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Start your shift' }

/**
 * The screen a till operator sees before anything else.
 *
 * Same shape as `/pending-approval` and `/trial-ended`: the guard elsewhere
 * redirects here, and this page re-checks the condition itself and bounces back
 * the moment it is satisfied. That second check is what stops a stale link or a
 * back button from parking somebody on an interstitial they have already
 * passed.
 *
 * Reachable by anyone who can operate a drawer, including a manager who wants
 * to open one deliberately — the gate is about who is *forced* here, not who is
 * allowed.
 */
export default async function CashierSessionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.CASH_DRAWER_OPERATE, '/cashier/session')

  const params = await searchParams
  const raw = typeof params.next === 'string' ? params.next : '/cashier'
  /*
   * Only a path on this app. An open redirect here would be handed to somebody
   * at the start of every shift, which is the most reliable delivery mechanism
   * a phishing link could ask for.
   */
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/cashier'

  // Already sorted — go and work. Managers who are not gated at all also land
  // straight back rather than being asked a question they did not have to
  // answer.
  if (await hasLiveSession(user.restaurantId, user.id)) redirect(next)

  const [restaurant, branches, handovers] = await Promise.all([
    requireRestaurant(user.restaurantId),
    listStationBranches(user),
    listPendingForUser(user.restaurantId, user.id),
  ])

  const registers = await listRegistersForBranches({
    restaurantId: user.restaurantId,
    branchIds: branches.map((b) => b.id),
  })

  return (
    <SessionStart
      cashierName={user.name}
      currency={restaurant.currency}
      next={next}
      branches={branches.map((b) => ({ id: b.id, name: b.name }))}
      registers={registers.map((r) => ({ id: r.id, name: r.name, branchId: r.branchId }))}
      handovers={handovers.map((h) => ({
        id: h.id,
        fromName: h.fromUser?.name ?? 'A colleague',
        branchName: h.branch?.name ?? null,
        registerName: h.register?.name ?? null,
        countedAmount: h.countedAmount,
        note: h.note,
      }))}
    />
  )
}
