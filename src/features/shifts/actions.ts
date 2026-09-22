'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import {
  assignShiftSchema,
  cancelShiftAssignmentSchema,
  createShiftTemplateSchema,
  setShiftTemplateActiveSchema,
  startAssignedShiftSchema,
  updateShiftAssignmentSchema,
  updateShiftTemplateSchema,
} from './schema'
import {
  assignShift,
  cancelShiftAssignment,
  createShiftTemplate,
  setShiftTemplateActive,
  startAssignedShift,
  updateShiftAssignment,
  updateShiftTemplate,
} from './service'

/**
 * Shift management (shifthandover.md §1–3).
 *
 *   templates   → shift.templates   owner / admin
 *   the rota    → shift.assign      owner / admin / manager, at their own site
 *   start mine  → shift.view        everybody who has a shift
 *
 * A manager is confined to their branch by the role itself
 * (`CROSS_LOCATION_ROLES` leaves MANAGER out), so `assertBranchAccess` on the
 * posted branch is the whole of "branch managers only manage their own".
 */

function touchShifts() {
  revalidatePath('/dashboard/shifts')
  revalidatePath('/dashboard/handover')
  revalidatePath('/cashier/pos')
}

function actorFor(user: { id: string; role: Parameters<typeof assignShift>[0]['actor']['role']; branchId?: string | null }) {
  return { id: user.id, role: user.role, branchId: user.branchId ?? null }
}

/* ── §1 templates ───────────────────────────────────────────────────────── */

export async function createShiftTemplateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    createShiftTemplateSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SHIFT_TEMPLATE_MANAGE)
      const branchId = data.branchId || null
      await assertBranchAccess(user, branchId)
      const row = await createShiftTemplate({
        restaurantId: user.restaurantId,
        actor: actorFor(user),
        name: data.name,
        startTime: data.startTime,
        endTime: data.endTime,
        roles: data.roles,
        branchId,
        sortOrder: data.sortOrder,
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_TEMPLATE_CREATED,
        entity: 'ShiftTemplate',
        entityId: row.id,
        after: { name: row.name, startTime: row.startTime, endTime: row.endTime, roles: row.roles, branchId },
      })
      touchShifts()
      return { id: row.id }
    },
    'Shift added.',
    'shifts.template.create',
  )
}

export async function updateShiftTemplateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    updateShiftTemplateSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SHIFT_TEMPLATE_MANAGE)
      const branchId = data.branchId || null
      await assertBranchAccess(user, branchId)
      const { before, after } = await updateShiftTemplate({
        restaurantId: user.restaurantId,
        actor: actorFor(user),
        templateId: data.templateId,
        name: data.name,
        startTime: data.startTime,
        endTime: data.endTime,
        roles: data.roles,
        branchId,
        sortOrder: data.sortOrder,
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_TEMPLATE_UPDATED,
        entity: 'ShiftTemplate',
        entityId: after.id,
        before: { name: before.name, startTime: before.startTime, endTime: before.endTime, roles: before.roles, branchId: before.branchId },
        after: { name: after.name, startTime: after.startTime, endTime: after.endTime, roles: after.roles, branchId: after.branchId },
      })
      touchShifts()
      return { id: after.id }
    },
    'Shift updated. Tomorrow’s rota uses the new times; nothing already rostered changes.',
    'shifts.template.update',
  )
}

export async function setShiftTemplateActiveAction(input: unknown): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  return runAction(
    setShiftTemplateActiveSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SHIFT_TEMPLATE_MANAGE)
      const row = await setShiftTemplateActive({
        restaurantId: user.restaurantId,
        actor: actorFor(user),
        templateId: data.templateId,
        isActive: data.isActive,
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId: row.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_TEMPLATE_UPDATED,
        entity: 'ShiftTemplate',
        entityId: row.id,
        after: { isActive: row.isActive },
      })
      touchShifts()
      return { id: row.id, isActive: row.isActive }
    },
    undefined,
    'shifts.template.toggle',
  )
}

/* ── §2 the rota ────────────────────────────────────────────────────────── */

export async function assignShiftAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    assignShiftSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SHIFT_ASSIGN)
      await assertBranchAccess(user, data.branchId)
      const restaurant = await requireRestaurant(user.restaurantId)
      const row = await assignShift({
        restaurantId: user.restaurantId,
        actor: actorFor(user),
        userId: data.userId,
        templateId: data.templateId,
        branchId: data.branchId,
        dateKey: data.date,
        notes: data.notes || null,
        timeZone: restaurant.timezone,
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId: row.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_ASSIGNED,
        entity: 'ShiftAssignment',
        entityId: row.id,
        after: {
          userId: row.userId,
          role: row.role,
          templateId: row.templateId,
          date: data.date,
          scheduledStartAt: row.scheduledStartAt,
          scheduledEndAt: row.scheduledEndAt,
        },
      })
      touchShifts()
      return { id: row.id }
    },
    'Rostered.',
    'shifts.assign',
  )
}

export async function updateShiftAssignmentAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    updateShiftAssignmentSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SHIFT_ASSIGN)
      const restaurant = await requireRestaurant(user.restaurantId)
      const { before, after } = await updateShiftAssignment({
        restaurantId: user.restaurantId,
        actor: actorFor(user),
        assignmentId: data.assignmentId,
        templateId: data.templateId,
        dateKey: data.date,
        notes: data.notes === undefined ? undefined : data.notes || null,
        timeZone: restaurant.timezone,
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId: after.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_ASSIGNMENT_UPDATED,
        entity: 'ShiftAssignment',
        entityId: after.id,
        before: { templateId: before.templateId, date: before.date, scheduledStartAt: before.scheduledStartAt, notes: before.notes },
        after: { templateId: after.templateId, date: after.date, scheduledStartAt: after.scheduledStartAt, notes: after.notes },
      })
      touchShifts()
      return { id: after.id }
    },
    'Rota updated.',
    'shifts.assignment.update',
  )
}

export async function cancelShiftAssignmentAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    cancelShiftAssignmentSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SHIFT_ASSIGN)
      const row = await cancelShiftAssignment({
        restaurantId: user.restaurantId,
        actor: actorFor(user),
        assignmentId: data.assignmentId,
        reason: data.reason,
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId: row.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_ASSIGNMENT_CANCELLED,
        entity: 'ShiftAssignment',
        entityId: row.id,
        after: { reason: data.reason, userId: row.userId, templateId: row.templateId, date: row.date },
      })
      touchShifts()
      return { id: row.id }
    },
    'Taken off the rota.',
    'shifts.assignment.cancel',
  )
}

/* ── §3 start the shift you were rostered on ───────────────────────────── */

export async function startAssignedShiftAction(input: unknown): Promise<ActionResult<{ shiftId: string }>> {
  return runAction(
    startAssignedShiftSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SHIFT_VIEW)
      const restaurant = await requireRestaurant(user.restaurantId)
      const { shift, assignment } = await startAssignedShift({
        restaurantId: user.restaurantId,
        user: actorFor(user),
        assignmentId: data.assignmentId,
        timeZone: restaurant.timezone,
      })
      await audit({
        restaurantId: user.restaurantId,
        branchId: shift.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_STARTED,
        entity: 'StaffShift',
        entityId: shift.id,
        after: {
          assignmentId: assignment.id,
          templateId: assignment.templateId,
          scheduledStartAt: assignment.scheduledStartAt,
          scheduledEndAt: assignment.scheduledEndAt,
          startedAt: shift.clockInAt,
          role: shift.roleAtStart,
        },
      })
      touchShifts()
      return { shiftId: shift.id }
    },
    'You are on shift.',
    'shifts.start',
  )
}
