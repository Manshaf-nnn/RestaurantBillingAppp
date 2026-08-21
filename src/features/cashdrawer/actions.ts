'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { minorUnitFactor } from '@/lib/money'
import { cashMovementSchema, closeDrawerSchema, openDrawerSchema } from './schema'
import { closeDrawer, getOpenDrawer, openDrawer, recordCashMovement } from './service'

/** Cashier-facing surfaces that show drawer state. */
function revalidateDrawer() {
  revalidatePath('/dashboard/cash-drawer')
  revalidatePath('/cashier')
}

/**
 * Cashier-entered major units → integer minor units.
 *
 * Uses the restaurant's own currency rather than a hardcoded ×100: a
 * zero-decimal currency would otherwise turn a Rs 5,000 float into 500,000 and
 * make every variance meaningless.
 */
async function toMinor(restaurantId: string, value: number): Promise<number> {
  const restaurant = await requireRestaurant(restaurantId)
  return Math.round(value * minorUnitFactor(restaurant.currency))
}

export async function openDrawerAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    openDrawerSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_OPERATE)

      const session = await openDrawer({
        restaurantId: user.restaurantId,
        userId: user.id,
        branchId: data.branchId || null,
        userBranchId: user.branchId ?? null,
        openingFloat: await toMinor(user.restaurantId, data.openingFloat),
        note: data.note || null,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.DRAWER_OPENED,
        entity: 'CashDrawerSession',
        entityId: session.id,
        after: { openingFloat: session.openingFloat, branchId: session.branchId },
      })

      revalidateDrawer()
      return { id: session.id }
    },
    'Drawer opened.',
  )
}

export async function recordCashMovementAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    cashMovementSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_OPERATE)

      const movement = await recordCashMovement({
        restaurantId: user.restaurantId,
        sessionId: data.sessionId,
        type: data.type,
        amount: await toMinor(user.restaurantId, data.amount),
        reason: data.reason,
        userId: user.id,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action:
          data.type === 'CASH_IN' ? AUDIT_ACTIONS.DRAWER_CASH_IN : AUDIT_ACTIONS.DRAWER_CASH_OUT,
        entity: 'CashMovement',
        entityId: movement.id,
        after: { amount: movement.amount, reason: movement.reason, sessionId: data.sessionId },
      })

      revalidateDrawer()
      return { id: movement.id }
    },
    'Recorded.',
  )
}

export async function closeDrawerAction(
  input: unknown,
): Promise<ActionResult<{ id: string; variance: number; expectedCash: number }>> {
  return runAction(
    closeDrawerSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_OPERATE)

      const { session, totals, variance } = await closeDrawer({
        restaurantId: user.restaurantId,
        sessionId: data.sessionId,
        countedCash: await toMinor(user.restaurantId, data.countedCash),
        note: data.note || null,
        userId: user.id,
      })

      // Closing a drawer is a money event an owner may need to review months
      // later, so the whole reconciliation is recorded, not just the outcome.
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.DRAWER_CLOSED,
        entity: 'CashDrawerSession',
        entityId: session.id,
        after: {
          openingFloat: totals.openingFloat,
          cashSales: totals.cashSales,
          cashIn: totals.cashIn,
          cashOut: totals.cashOut,
          expectedCash: totals.expectedCash,
          countedCash: session.countedCash,
          variance,
        },
      })

      revalidateDrawer()
      return { id: session.id, variance, expectedCash: totals.expectedCash }
    },
    'Drawer closed.',
  )
}

/** Used by the counter screen to decide whether to prompt for an open drawer. */
export async function getMyOpenDrawerAction(): Promise<ActionResult<{ id: string } | null>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.CASH_DRAWER_OPERATE)
    const session = await getOpenDrawer(user.restaurantId, user.id)
    return session ? { id: session.id } : null
  })
}
