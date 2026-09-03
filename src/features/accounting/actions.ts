'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { ValidationError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { getMonthCloseChecklist } from './month-close'
import { NOTE_ENTITIES, addNote } from './notes'
import { closeDay, closePeriod, reopenPeriod } from './service'

const closeDaySchema = z.object({
  /** The local business date, as YYYY-MM-DD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
})

const closePeriodSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
})

const reopenPeriodSchema = z.object({
  periodId: z.string().cuid(),
})

const closeMonthSchema = z.object({
  /** YYYY-MM. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  /** Typed CLOSE when the checklist is not fully green. */
  override: z.string().trim().optional(),
})

const foodCostTargetSchema = z.object({
  /** Percent as typed, e.g. 30 or 32.5. Empty clears the target. */
  percent: z.string().trim().max(6),
})

const addNoteSchema = z.object({
  entity: z.enum(NOTE_ENTITIES),
  entityId: z.string().min(1).max(80),
  body: z.string().trim().min(1).max(500),
  branchId: z.string().cuid().optional().nullable(),
})

/** Sign off one business day: freeze its figures as the record (§50–51). */
export async function closeDayAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(closeDaySchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_CLOSE)
    const restaurant = await requireRestaurant(user.restaurantId)

    const closed = await closeDay({
      restaurantId: user.restaurantId,
      businessDate: new Date(`${data.date}T00:00:00.000Z`),
      timeZone: restaurant.timezone,
      userId: user.id,
      notes: data.notes || null,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.DAY_CLOSED,
      entity: 'DailyClose',
      entityId: closed.id,
      after: { businessDate: data.date },
    })

    revalidatePath('/dashboard/reports/daily-close')
    return { id: closed.id }
  }, 'Day closed. The figures are on the record.')
}

/** Seal a signed range: the orders inside refuse edits until reopened (§59). */
export async function closePeriodAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(closePeriodSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_CLOSE)

    const period = await closePeriod({
      restaurantId: user.restaurantId,
      from: new Date(`${data.from}T00:00:00.000Z`),
      // Inclusive end date: the period covers all of its last day.
      to: new Date(new Date(`${data.to}T00:00:00.000Z`).getTime() + 86_400_000),
      userId: user.id,
      notes: data.notes || null,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.PERIOD_CLOSED,
      entity: 'AccountingPeriod',
      entityId: period.id,
      after: { from: data.from, to: data.to },
    })

    revalidatePath('/dashboard/reports/daily-close')
    return { id: period.id }
  }, 'Period closed. Its orders are sealed.')
}

/** Unseal a period, on the record — the audit trail says who and when. */
export async function reopenPeriodAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(reopenPeriodSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_CLOSE)

    const period = await reopenPeriod({
      restaurantId: user.restaurantId,
      periodId: data.periodId,
      userId: user.id,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.PERIOD_REOPENED,
      entity: 'AccountingPeriod',
      entityId: period.id,
      after: {
        from: period.periodStart.toISOString().slice(0, 10),
        to: period.periodEnd.toISOString().slice(0, 10),
      },
    })

    revalidatePath('/dashboard/reports/daily-close')
    return { id: period.id }
  }, 'Period reopened. Changes there are on your name now.')
}

/**
 * Close a whole month (acCal.md §13). The checklist is re-run server-side —
 * a green screen is not evidence, the records are — and closing over an
 * incomplete checklist demands the word CLOSE and a written reason, both of
 * which land in the period's notes for whoever reads the books later.
 */
export async function closeMonthAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(closeMonthSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_CLOSE)
    const restaurant = await requireRestaurant(user.restaurantId)

    const checklist = await getMonthCloseChecklist({
      restaurantId: user.restaurantId,
      month: data.month,
      timeZone: restaurant.timezone,
    })
    const outstanding = checklist.items.filter((item) => !item.done)

    if (outstanding.length > 0) {
      if (data.override !== 'CLOSE') {
        throw new ValidationError(
          `${outstanding.length} check(s) are not clear yet: ${outstanding.map((item) => item.label).join('; ')}. Type CLOSE to seal the month anyway.`,
        )
      }
      if (!data.notes) {
        throw new ValidationError('Closing over open checks needs a written reason.')
      }
    }

    const notes = [
      data.notes || null,
      outstanding.length > 0
        ? `Closed with ${outstanding.length} check(s) outstanding: ${outstanding.map((item) => item.label).join('; ')}`
        : null,
    ]
      .filter(Boolean)
      .join(' — ')

    const period = await closePeriod({
      restaurantId: user.restaurantId,
      from: checklist.month.from,
      to: checklist.month.to,
      userId: user.id,
      notes: notes || null,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.PERIOD_CLOSED,
      entity: 'AccountingPeriod',
      entityId: period.id,
      after: {
        month: data.month,
        readyPercent: checklist.readyPercent,
        outstanding: outstanding.map((item) => item.key),
      },
    })

    revalidatePath('/dashboard/accounting/close')
    revalidatePath('/dashboard/reports/daily-close')
    return { id: period.id }
  }, 'Month closed. Everything inside it is sealed.')
}

/**
 * Set (or clear) the expected food-cost percentage the variance screen
 * compares against — the only stored "expected" figure in the system.
 */
export async function setFoodCostTargetAction(input: unknown): Promise<ActionResult<{ bps: number | null }>> {
  return runAction(foodCostTargetSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_CLOSE)
    const before = await requireRestaurant(user.restaurantId)

    let bps: number | null = null
    if (data.percent !== '') {
      const value = Number.parseFloat(data.percent)
      if (!Number.isFinite(value) || value <= 0 || value >= 100) {
        throw new ValidationError('A food-cost target is a percentage between 0 and 100.')
      }
      bps = Math.round(value * 100)
    }

    await prisma.restaurant.update({
      where: { id: user.restaurantId },
      data: { targetFoodCostBps: bps },
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.FOOD_COST_TARGET_SET,
      entity: 'Restaurant',
      entityId: user.restaurantId,
      before: { targetFoodCostBps: before.targetFoodCostBps },
      after: { targetFoodCostBps: bps },
    })

    revalidatePath('/dashboard/accounting/reports/variance')
    return { bps }
  }, 'Target saved.')
}

/**
 * Pin a signed note to a financial record, or acknowledge a standing issue
 * (entity 'issue'). Append-only — there is deliberately no edit or delete.
 */
export async function addAccountantNoteAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(addNoteSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_NOTE)

    const note = await addNote({
      restaurantId: user.restaurantId,
      branchId: data.branchId ?? null,
      entity: data.entity,
      entityId: data.entityId,
      body: data.body,
      authorId: user.id,
      authorName: user.name,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.ACCOUNTANT_NOTE_ADDED,
      entity: 'AccountantNote',
      entityId: note.id,
      after: { entity: data.entity, entityId: data.entityId, body: data.body },
    })

    revalidatePath('/dashboard/accounting')
    revalidatePath('/dashboard/accounting/reconciliation')
    revalidatePath('/dashboard/invoices')
    return { id: note.id }
  }, 'Noted, on the record.')
}
