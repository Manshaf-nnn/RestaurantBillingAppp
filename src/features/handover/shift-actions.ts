'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS, can } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { minorUnitFactor } from '@/lib/money'
import { resolveBranchId } from '@/features/branches/service'
import type { DrawerActor } from '@/features/cashdrawer/service'
import { denominationsFor } from '@/features/cashdrawer/denominations'
import {
  previewShiftHandoverSchema,
  rejectShiftHandoverSchema,
  shiftHandoverIdSchema,
  startShiftHandoverSchema,
} from './shift-schema'
import {
  acceptShiftHandover,
  buildHandoverSummary,
  cancelShiftHandover,
  listEligibleReceivers,
  rejectShiftHandover,
  startShiftHandover,
} from './shift-service'
import type { HandoverDone, HandoverPreview, HandoverSummary } from './shift-types'

/**
 * The shift handover (recorrection.md §2). Every action is gated on
 * `handover.view` — the permission every floor role already holds, because
 * handing a shift over is something everybody does — plus the rule the
 * service enforces about WHO may do WHICH step: only the receiver accepts or
 * rejects; the outgoing person or a manager withdraws.
 */

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

function personFor(user: { id: string; name: string; role: DrawerActor['role']; branchId?: string | null }) {
  return { id: user.id, name: user.name, role: user.role, branchId: user.branchId ?? null }
}

function revalidateHandover() {
  revalidatePath('/dashboard/handover')
  revalidatePath('/dashboard/cash-drawer')
  revalidatePath('/cashier')
  revalidatePath('/cashier/pos')
  revalidatePath('/cashier/session')
}

/**
 * Which site the handover is at. A confined person's is their own; somebody
 * who works across every location says which, and it is checked like any
 * posted branch id.
 */
async function branchFor(
  user: Awaited<ReturnType<typeof requirePermission>>,
  requested: string | undefined,
): Promise<string> {
  const branchId = await resolveBranchId({
    restaurantId: user.restaurantId,
    requestedBranchId: requested || null,
    userBranchId: user.branchId,
  })
  await assertBranchAccess(user, branchId)
  return branchId
}

/** What the wizard shows at Review: the summary now, and who may take over. */
export async function previewShiftHandoverAction(
  input: unknown,
): Promise<ActionResult<HandoverPreview>> {
  return runAction(
    previewShiftHandoverSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.HANDOVER_VIEW)
      const restaurant = await requireRestaurant(user.restaurantId)
      const branchId = await branchFor(user, data.branchId || undefined)

      const built = await buildHandoverSummary({
        restaurantId: user.restaurantId,
        branchId,
        user: personFor(user),
        timeZone: restaurant.timezone,
        // The person counting is not shown the target (shifthandover.md
        // "Cash drawer — critical"); somebody who manages drawers already
        // sees expected cash on every other screen.
        revealExpected: can(user, PERMISSIONS.CASH_DRAWER_MANAGE),
      })
      const receivers = await listEligibleReceivers({
        restaurantId: user.restaurantId,
        from: personFor(user),
        branchId,
        withTill: built.sessionId !== null,
      })
      return {
        branchId,
        branchName: built.summary.branchName,
        summary: built.summary,
        receivers,
        hasDrawer: built.sessionId !== null,
        denominations: denominationsFor(restaurant.currency).map((d) => ({ value: d.value, label: d.label, kind: d.kind })),
      }
    },
  )
}

/** Confirm: hand the shift (and the till, when there is one) to somebody. */
export async function startShiftHandoverAction(
  input: unknown,
): Promise<ActionResult<{ id: string; cashHandoverId: string | null; drawer: HandoverDone['drawer'] }>> {
  return runAction(
    startShiftHandoverSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.HANDOVER_VIEW)
      const restaurant = await requireRestaurant(user.restaurantId)
      const branchId = await branchFor(user, data.branchId || undefined)

      const handover = await startShiftHandover({
        restaurantId: user.restaurantId,
        from: personFor(user),
        actor: actorFor(user),
        branchId,
        toUserId: data.toUserId,
        notes: data.notes || null,
        countedAmount:
          data.countedAmount === null || data.countedAmount === undefined
            ? null
            : Math.round(data.countedAmount * minorUnitFactor(restaurant.currency)),
        counts: data.counts ?? null,
        varianceReason: data.varianceReason || null,
        timeZone: restaurant.timezone,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_HANDOVER_STARTED,
        entity: 'ShiftHandover',
        entityId: handover.id,
        after: { toUserId: handover.toUserId, cashHandoverId: handover.cashHandoverId },
      })

      revalidateHandover()
      /*
       * The count is submitted, so the reconciliation may now be shown to
       * the person who counted (shifthandover.md "Cash drawer — critical").
       */
      const stored = (handover.summary as unknown as HandoverSummary).drawer
      return {
        id: handover.id,
        cashHandoverId: handover.cashHandoverId,
        drawer: stored
          ? {
              countedCash: stored.countedCash ?? 0,
              expectedCash: stored.expectedCash ?? 0,
              variance: stored.variance ?? 0,
              needsReview: stored.needsReview ?? false,
            }
          : null,
      }
    },
    'Handed over. They review and accept it on their screen.',
  )
}

export async function acceptShiftHandoverAction(
  input: unknown,
): Promise<ActionResult<{ id: string; sessionId: string | null }>> {
  return runAction(
    shiftHandoverIdSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.HANDOVER_VIEW)
      const restaurant = await requireRestaurant(user.restaurantId)
      const { handover, sessionId } = await acceptShiftHandover({
        restaurantId: user.restaurantId,
        handoverId: data.handoverId,
        user: personFor(user),
        actor: actorFor(user),
        timeZone: restaurant.timezone,
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId: handover.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_HANDOVER_COMPLETED,
        entity: 'ShiftHandover',
        entityId: handover.id,
        after: { fromUserId: handover.fromUserId, sessionId },
      })
      revalidateHandover()
      return { id: handover.id, sessionId }
    },
    'Shift accepted.',
  )
}

export async function rejectShiftHandoverAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    rejectShiftHandoverSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.HANDOVER_VIEW)
      const handover = await rejectShiftHandover({
        restaurantId: user.restaurantId,
        handoverId: data.handoverId,
        user: personFor(user),
        actor: actorFor(user),
        reason: data.reason,
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId: handover.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_HANDOVER_REJECTED,
        entity: 'ShiftHandover',
        entityId: handover.id,
        after: { fromUserId: handover.fromUserId, reason: data.reason },
      })
      revalidateHandover()
      return { id: handover.id }
    },
    'Not accepted. They have been told why.',
  )
}

export async function cancelShiftHandoverAction(
  input: unknown,
): Promise<ActionResult<{ id: string; reopenedSessionId: string | null }>> {
  return runAction(
    shiftHandoverIdSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.HANDOVER_VIEW)
      const { handover, reopenedSessionId } = await cancelShiftHandover({
        restaurantId: user.restaurantId,
        handoverId: data.handoverId,
        user: personFor(user),
        actor: actorFor(user),
        // A manager clears a handover the receiver never showed up for.
        mayCancelOthers: can(user, PERMISSIONS.STAFF_MANAGE) || can(user, PERMISSIONS.CASH_DRAWER_MANAGE),
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId: handover.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_HANDOVER_CANCELLED,
        entity: 'ShiftHandover',
        entityId: handover.id,
        after: { toUserId: handover.toUserId, reopenedSessionId },
      })
      if (reopenedSessionId && handover.cashHandoverId) {
        await audit({
          restaurantId: user.restaurantId,
          branchId: handover.branchId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.DRAWER_HANDOVER_CANCELLED,
          entity: 'CashHandover',
          entityId: handover.cashHandoverId,
          after: { reopenedSessionId },
        })
      }
      revalidateHandover()
      return { id: handover.id, reopenedSessionId }
    },
    'Withdrawn.',
  )
}
