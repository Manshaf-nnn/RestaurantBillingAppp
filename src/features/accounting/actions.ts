'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
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
