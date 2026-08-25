'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS, can } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { resolveBranchId } from '@/features/branches/service'
import { minorUnitFactor } from '@/lib/money'
import {
  pettyDecisionSchema,
  pettyIdSchema,
  pettyPaySchema,
  pettyRequestSchema,
} from './schema'
import {
  cancelRequest,
  createRequest,
  decideRequest,
  payRequest,
  submitRequest,
  type PettyActor,
} from './service'

/**
 * Petty cash actions.
 *
 * The permission split is the point: PETTY_CASH_REQUEST raises one,
 * PETTY_CASH_APPROVE decides and pays. Handing both to the same person by
 * default would make the approval a formality, which is what the service's
 * approver-≠-requester rule then also refuses above the threshold.
 */
function actorFor(user: {
  id: string
  role: PettyActor['role']
  branchId?: string | null
  permissions?: string[]
}): PettyActor {
  return {
    id: user.id,
    role: user.role,
    branchId: user.branchId ?? null,
    canApprove: can(user, PERMISSIONS.PETTY_CASH_APPROVE),
  }
}

function revalidatePetty() {
  revalidatePath('/dashboard/petty-cash')
  revalidatePath('/dashboard/cash-drawer')
  revalidatePath('/dashboard/reports/petty-cash')
}

async function toMinor(restaurantId: string, value: number): Promise<number> {
  const restaurant = await requireRestaurant(restaurantId)
  return Math.round(value * minorUnitFactor(restaurant.currency))
}

export async function createPettyRequestAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    pettyRequestSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PETTY_CASH_REQUEST)
      await assertBranchAccess(user, data.branchId || null)

      /*
       * Check what was resolved, not only what was posted. `assertBranchAccess`
       * early-returns on a falsy branch, and `resolveBranchId` then falls back
       * to the restaurant default — so posting nothing raised a request against
       * a location the person may not be able to see. See the same note in
       * `openDrawerAction`.
       */
      const branchId = await resolveBranchId({
        restaurantId: user.restaurantId,
        requestedBranchId: data.branchId || null,
        userBranchId: user.branchId ?? null,
      })
      await assertBranchAccess(user, branchId)

      const request = await createRequest({
        restaurantId: user.restaurantId,
        branchId,
        userBranchId: user.branchId ?? null,
        category: data.category,
        description: data.description,
        amount: await toMinor(user.restaurantId, data.amount),
        reference: data.reference || null,
        paidFrom: data.paidFrom,
        userId: user.id,
        draft: data.draft,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.PETTY_CASH_REQUESTED,
        entity: 'PettyCashRequest',
        entityId: request.id,
        after: {
          amount: request.amount,
          category: request.category,
          description: request.description,
          paidFrom: request.paidFrom,
          branchId: request.branchId,
        },
      })

      revalidatePetty()
      return { id: request.id }
    },
    'Request saved.',
  )
}

export async function submitPettyRequestAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    pettyIdSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PETTY_CASH_REQUEST)
      const request = await submitRequest({
        restaurantId: user.restaurantId,
        requestId: data.requestId,
        userId: user.id,
        actor: actorFor(user),
      })
      revalidatePetty()
      return { id: request.id }
    },
    'Sent for approval.',
  )
}

export async function decidePettyRequestAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    pettyDecisionSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PETTY_CASH_APPROVE)

      const request = await decideRequest({
        restaurantId: user.restaurantId,
        requestId: data.requestId,
        approve: data.approve,
        note: data.note || null,
        userId: user.id,
        actor: actorFor(user),
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: data.approve
          ? AUDIT_ACTIONS.PETTY_CASH_APPROVED
          : AUDIT_ACTIONS.PETTY_CASH_REJECTED,
        entity: 'PettyCashRequest',
        entityId: request.id,
        after: {
          amount: request.amount,
          description: request.description,
          decisionNote: request.decisionNote,
        },
      })

      revalidatePetty()
      return { id: request.id }
    },
    'Decision recorded.',
  )
}

/**
 * Hand the notes over.
 *
 * The one action that moves money, which is why it is the one with its own
 * audit entry carrying the drawer session — an owner asking "where did this
 * Rs 3,000 go" gets the till, the shift and the person in one row.
 */
export async function payPettyRequestAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    pettyPaySchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PETTY_CASH_APPROVE)

      const request = await payRequest({
        restaurantId: user.restaurantId,
        requestId: data.requestId,
        sessionId: data.sessionId,
        userId: user.id,
        actor: actorFor(user),
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.PETTY_CASH_PAID,
        entity: 'PettyCashRequest',
        entityId: request.id,
        after: {
          amount: request.amount,
          description: request.description,
          paidFrom: request.paidFrom,
          sessionId: request.sessionId,
          branchId: request.branchId,
        },
      })

      revalidatePetty()
      return { id: request.id }
    },
    'Paid.',
  )
}

export async function cancelPettyRequestAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    pettyIdSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PETTY_CASH_REQUEST)

      const request = await cancelRequest({
        restaurantId: user.restaurantId,
        requestId: data.requestId,
        userId: user.id,
        actor: actorFor(user),
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.PETTY_CASH_CANCELLED,
        entity: 'PettyCashRequest',
        entityId: request.id,
        after: { amount: request.amount, description: request.description },
      })

      revalidatePetty()
      return { id: request.id }
    },
    'Withdrawn.',
  )
}
