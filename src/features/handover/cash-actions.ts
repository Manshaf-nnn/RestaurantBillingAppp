'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS, can } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { minorUnitFactor } from '@/lib/money'
import type { DrawerActor } from '@/features/cashdrawer/service'
import { handoverIdSchema, handoverRequestSchema } from './cash-schema'
import { acceptHandover, declineHandover, requestHandover } from './cash-service'

function actorFor(user: {
  id: string
  role: DrawerActor['role']
  branchId?: string | null
  permissions?: string[]
}): DrawerActor {
  return {
    id: user.id,
    role: user.role,
    branchId: user.branchId ?? null,
    canManageOthers: can(user, PERMISSIONS.CASH_DRAWER_MANAGE),
  }
}

function revalidateHandover() {
  revalidatePath('/dashboard/handover')
  revalidatePath('/dashboard/cash-drawer')
  revalidatePath('/cashier')
  revalidatePath('/cashier/session')
}

async function toMinor(restaurantId: string, value: number): Promise<number> {
  const restaurant = await requireRestaurant(restaurantId)
  return Math.round(value * minorUnitFactor(restaurant.currency))
}

/**
 * Count the till and offer it to the next cashier.
 *
 * Guarded by CASH_DRAWER_OPERATE, not MANAGE: handing your own till on at the
 * end of your shift is the ordinary case, and requiring a manager for it would
 * mean either finding one at 11pm or leaving the drawer open all night.
 */
export async function requestHandoverAction(
  input: unknown,
): Promise<ActionResult<{ id: string; variance: number }>> {
  return runAction(
    handoverRequestSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_OPERATE)

      const handover = await requestHandover({
        restaurantId: user.restaurantId,
        sessionId: data.sessionId,
        toUserId: data.toUserId,
        countedAmount: await toMinor(user.restaurantId, data.countedAmount),
        varianceReason: data.varianceReason || null,
        note: data.note || null,
        userId: user.id,
        actor: actorFor(user),
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.DRAWER_HANDED_OVER,
        entity: 'CashHandover',
        entityId: handover.id,
        after: {
          toUserId: handover.toUserId,
          branchId: handover.branchId,
          registerId: handover.registerId,
          expectedAmount: handover.expectedAmount,
          countedAmount: handover.countedAmount,
          variance: handover.variance,
        },
      })

      revalidateHandover()
      return { id: handover.id, variance: handover.variance }
    },
    'Handed over. The next cashier confirms it on their screen.',
  )
}

export async function acceptHandoverAction(
  input: unknown,
): Promise<ActionResult<{ id: string; sessionId: string }>> {
  return runAction(
    handoverIdSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_OPERATE)

      const { handover, sessionId } = await acceptHandover({
        restaurantId: user.restaurantId,
        handoverId: data.handoverId,
        userId: user.id,
        actor: actorFor(user),
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.DRAWER_HANDOVER_ACCEPTED,
        entity: 'CashHandover',
        entityId: handover.id,
        after: { sessionId, openingFloat: handover.countedAmount },
      })

      revalidateHandover()
      return { id: handover.id, sessionId }
    },
    'Till taken on.',
  )
}

export async function declineHandoverAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    handoverIdSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_OPERATE)

      const handover = await declineHandover({
        restaurantId: user.restaurantId,
        handoverId: data.handoverId,
        userId: user.id,
        actor: actorFor(user),
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.DRAWER_HANDOVER_DECLINED,
        entity: 'CashHandover',
        entityId: handover.id,
        after: { countedAmount: handover.countedAmount, variance: handover.variance },
      })

      revalidateHandover()
      return { id: handover.id }
    },
    'Declined.',
  )
}
