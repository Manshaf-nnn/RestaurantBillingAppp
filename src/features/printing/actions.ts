'use server'

import { z } from 'zod'
import type { Prisma } from '@prisma/client'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { requireAnyPermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

const recordPrintSchema = z.object({
  orderId: z.string().cuid().optional().or(z.literal('')),
  kind: z.enum(['BILL', 'RECEIPT', 'KITCHEN']),
  ok: z.coerce.boolean(),
  /** The rendered receipt object, verbatim — what a reprint reproduces. */
  payload: z.unknown(),
})

/**
 * Record one print attempt (§80).
 *
 * Printing happens in the browser and used to vanish the moment the dialog
 * closed. Every attempt is a row now, carrying the exact payload that was
 * rendered — so "print it again" replays the same document, and a failed
 * print is visible instead of being a shrug at the till. Never blocks the
 * print itself: the caller fires this after the fact.
 */
export async function recordPrint(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(recordPrintSchema, input, async (data) => {
    const user = await requireAnyPermission([
      PERMISSIONS.PAYMENT_COLLECT,
      PERMISSIONS.ORDER_VIEW,
      PERMISSIONS.KITCHEN_VIEW,
    ])

    const order = data.orderId
      ? await prisma.order.findFirst({
          where: { id: data.orderId, restaurantId: user.restaurantId },
          select: { id: true, branchId: true },
        })
      : null

    const job = await prisma.printJob.create({
      data: {
        restaurantId: user.restaurantId,
        branchId: order?.branchId ?? user.branchId ?? null,
        orderId: order?.id ?? null,
        kind: data.kind,
        status: data.ok ? 'PRINTED' : 'FAILED',
        payload: (data.payload ?? {}) as Prisma.InputJsonValue,
        createdById: user.id,
      },
    })
    return { id: job.id }
  })
}

/** The print history for one order, newest first — the reprint list. */
export async function listPrints(orderId: string): Promise<
  ActionResult<{
    prints: Array<{ id: string; kind: string; status: string; createdAt: string; payload: unknown }>
  }>
> {
  return runAction(z.object({ orderId: z.string().cuid() }), { orderId }, async (data) => {
    const user = await requireAnyPermission([PERMISSIONS.PAYMENT_COLLECT, PERMISSIONS.ORDER_VIEW])
    const prints = await prisma.printJob.findMany({
      where: { restaurantId: user.restaurantId, orderId: data.orderId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    return {
      prints: prints.map((job) => ({
        id: job.id,
        kind: job.kind,
        status: job.status,
        createdAt: job.createdAt.toISOString(),
        payload: job.payload,
      })),
    }
  })
}
