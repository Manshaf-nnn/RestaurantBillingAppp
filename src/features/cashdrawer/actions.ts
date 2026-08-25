'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { AppError } from '@/lib/errors'
import { PERMISSIONS, can } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { resolveBranchId } from '@/features/branches/service'
import { minorUnitFactor } from '@/lib/money'
import { directionOf } from './movement-types'
import {
  cashMovementSchema,
  closeDrawerSchema,
  forceCloseDrawerSchema,
  openDrawerSchema,
  registerActiveSchema,
  registerSchema,
  reviewDrawerSchema,
} from './schema'
import {
  closeDrawer,
  forceCloseDrawer,
  getOpenDrawer,
  openDrawer,
  recordCashMovement,
  reviewDrawer,
  type DrawerActor,
} from './service'
import { createRegister, requireRegister, setRegisterActive } from './registers'

/**
 * Who is reaching for the drawer, in the shape the service checks against.
 *
 * `canManageOthers` is decided here rather than in the service, because it is a
 * permission question and permissions are the actions' business. A cashier
 * holds CASH_DRAWER_OPERATE and works their own till; a manager also holds
 * CASH_DRAWER_MANAGE and reconciles the floor.
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

/** Cashier-facing surfaces that show drawer state. */
function revalidateDrawer() {
  revalidatePath('/dashboard/cash-drawer')
  revalidatePath('/dashboard/petty-cash')
  revalidatePath('/cashier')
  revalidatePath('/cashier/session')
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
      /*
       * The posted branch has to be one this person may reach. `openDrawer`
       * resolves it through `resolveBranchId`, which only checks that the
       * branch belongs to the restaurant — a tenancy check, not a permission
       * one — so a Kandy cashier could open a till at Colombo by posting its
       * id. The module imported this guard and never called it.
       *
       * The register is checked inside `resolveRegisterId`, against the branch
       * that came out of this: a till id from another site cannot attach.
       */
      await assertBranchAccess(user, data.branchId || null)

      /*
       * Resolve first, then check what was resolved.
       *
       * `assertBranchAccess` early-returns on a falsy branch, so posting no
       * branch at all skipped the check entirely — and `resolveBranchId` then
       * falls back to the restaurant's DEFAULT branch. For somebody unassigned
       * (branchId null, `visibleBranchIds` = [], sees nothing) that opened a
       * drawer at Main, a location they cannot see a single figure from. The
       * concrete id is passed on, so the branch that was checked is the branch
       * that gets used.
       */
      const branchId = await resolveBranchId({
        restaurantId: user.restaurantId,
        requestedBranchId: data.branchId || null,
        userBranchId: user.branchId ?? null,
      })
      await assertBranchAccess(user, branchId)

      const session = await openDrawer({
        restaurantId: user.restaurantId,
        userId: user.id,
        branchId,
        registerId: data.registerId || null,
        userBranchId: user.branchId ?? null,
        openingFloat: await toMinor(user.restaurantId, data.openingFloat),
        openingPettyCash: data.openingPettyCash
          ? await toMinor(user.restaurantId, data.openingPettyCash)
          : 0,
        note: data.note || null,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.DRAWER_OPENED,
        entity: 'CashDrawerSession',
        entityId: session.id,
        after: {
          sessionNumber: session.sessionNumber,
          openingFloat: session.openingFloat,
          openingPettyCash: session.openingPettyCash,
          branchId: session.branchId,
          registerId: session.registerId,
        },
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
        actor: actorFor(user),
        sessionId: data.sessionId,
        type: data.type,
        amount: await toMinor(user.restaurantId, data.amount),
        reason: data.reason,
        reference: data.reference || null,
        userId: user.id,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        // The direction, not the type, because an owner scanning the log wants
        // to know which way the money went before they want to know why.
        action:
          directionOf(data.type) > 0
            ? AUDIT_ACTIONS.DRAWER_CASH_IN
            : AUDIT_ACTIONS.DRAWER_CASH_OUT,
        entity: 'CashMovement',
        entityId: movement.id,
        after: {
          type: movement.type,
          amount: movement.amount,
          reason: movement.reason,
          reference: movement.reference,
          sessionId: data.sessionId,
        },
      })

      revalidateDrawer()
      return { id: movement.id }
    },
    'Recorded.',
  )
}

export async function closeDrawerAction(
  input: unknown,
): Promise<ActionResult<{
  id: string
  variance: number
  expectedCash: number
  needsReview: boolean
}>> {
  return runAction(
    closeDrawerSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_OPERATE)

      const { session, totals, variance, needsReview } = await closeDrawer({
        restaurantId: user.restaurantId,
        actor: actorFor(user),
        sessionId: data.sessionId,
        countedCash: await toMinor(user.restaurantId, data.countedCash),
        varianceReason: data.varianceReason || null,
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
          sessionNumber: session.sessionNumber,
          openingFloat: totals.openingFloat,
          cashSales: totals.cashSales,
          cashIn: totals.cashIn,
          cashOut: totals.cashOut,
          expectedCash: totals.expectedCash,
          countedCash: session.countedCash,
          variance,
          varianceReason: session.varianceReason,
          status: session.status,
        },
      })

      revalidateDrawer()
      return { id: session.id, variance, expectedCash: totals.expectedCash, needsReview }
    },
    'Drawer closed.',
  )
}

/**
 * Close a drawer somebody left open.
 *
 * Guarded by CASH_DRAWER_MANAGE, and that finally matches the service: closing
 * another person's session has always required `canManageOthers` inside
 * `requireOpenSession`, while `closeDrawerAction` asked only for OPERATE. A
 * head-office role holding MANAGE alone was refused by the action for something
 * the service would have allowed.
 */
export async function forceCloseDrawerAction(
  input: unknown,
): Promise<ActionResult<{ id: string; variance: number | null }>> {
  return runAction(
    forceCloseDrawerSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_MANAGE)

      if (data.counted && data.countedCash === undefined) {
        throw new AppError('Enter what you counted', 400, 'DRAWER_NO_COUNT')
      }

      const { session, totals, variance } = await forceCloseDrawer({
        restaurantId: user.restaurantId,
        sessionId: data.sessionId,
        countedCash: data.counted
          ? await toMinor(user.restaurantId, data.countedCash ?? 0)
          : null,
        reason: data.reason,
        userId: user.id,
        actor: actorFor(user),
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: session.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.DRAWER_FORCE_CLOSED,
        entity: 'CashDrawerSession',
        entityId: session.id,
        after: {
          sessionNumber: session.sessionNumber,
          openedById: session.openedById,
          expectedCash: totals.expectedCash,
          countedCash: session.countedCash,
          // Spelled out rather than left to a null: "unknown" is the fact.
          variance: variance === null ? 'unknown — not counted' : variance,
          reason: session.varianceReason,
          status: session.status,
        },
      })

      revalidateDrawer()
      return { id: session.id, variance }
    },
    'Drawer closed.',
  )
}

/** Sign off a drawer that stopped for review. */
export async function reviewDrawerAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    reviewDrawerSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_MANAGE)

      const session = await reviewDrawer({
        restaurantId: user.restaurantId,
        sessionId: data.sessionId,
        userId: user.id,
        note: data.note || null,
        actor: actorFor(user),
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.DRAWER_REVIEWED,
        entity: 'CashDrawerSession',
        entityId: session.id,
        after: {
          sessionNumber: session.sessionNumber,
          variance: session.variance,
          reviewNote: session.reviewNote,
        },
      })

      revalidateDrawer()
      return { id: session.id }
    },
    'Signed off.',
  )
}

// ── tills ────────────────────────────────────────────────────────────────────

export async function createRegisterAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    registerSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_MANAGE)
      await assertBranchAccess(user, data.branchId)

      const register = await createRegister({
        restaurantId: user.restaurantId,
        branchId: data.branchId,
        name: data.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.REGISTER_CREATED,
        entity: 'CashRegister',
        entityId: register.id,
        after: { name: register.name, branchId: register.branchId },
      })

      revalidatePath('/dashboard/cash-drawer')
      return { id: register.id }
    },
    'Till added.',
  )
}

export async function setRegisterActiveAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    registerActiveSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CASH_DRAWER_MANAGE)

      // Read first: the row is the only place that says which branch this till
      // is at, and the check has to happen before the write, not after it.
      const existing = await requireRegister(user.restaurantId, data.registerId)
      await assertBranchAccess(user, existing.branchId)

      const register = await setRegisterActive({
        restaurantId: user.restaurantId,
        registerId: data.registerId,
        isActive: data.isActive,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.REGISTER_TOGGLED,
        entity: 'CashRegister',
        entityId: register.id,
        after: { name: register.name, isActive: register.isActive },
      })

      revalidatePath('/dashboard/cash-drawer')
      return { id: register.id }
    },
    'Till updated.',
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
