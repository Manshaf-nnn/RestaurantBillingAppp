'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import {
  approveTransfer, closeTransfer, dispatchTransfer, receiveTransfer, requestTransfer,
} from './service'

const REASONS = ['DAMAGED_IN_TRANSIT', 'MISSING', 'REJECTED_ON_ARRIVAL', 'OTHER'] as const

function touch(id?: string) {
  revalidatePath('/dashboard/transfers')
  if (id) revalidatePath(`/dashboard/transfers/${id}`)
  revalidatePath('/dashboard/inventory')
}

export async function requestTransferAction(
  input: unknown,
): Promise<ActionResult<{ id: string; number: string }>> {
  return runAction(
    z.object({
      fromBranchId: z.string().min(1, 'Choose where it is coming from'),
      toBranchId: z.string().min(1, 'Choose where it is going'),
      notes: z.string().trim().max(300).optional().or(z.literal('')),
      lines: z.array(z.object({
        itemId: z.string().min(1),
        quantity: z.coerce.number().positive().max(1_000_000),
      })).min(1, 'Add at least one item'),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TRANSFER_REQUEST)
      await assertBranchAccess(user, data.fromBranchId)
      const transfer = await requestTransfer({
        restaurantId: user.restaurantId,
        fromBranchId: data.fromBranchId,
        toBranchId: data.toBranchId,
        notes: data.notes || null,
        lines: data.lines,
        userId: user.id,
      })
      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.TRANSFER_REQUESTED, entity: 'StockTransfer', entityId: transfer.id,
        after: { number: transfer.number, from: data.fromBranchId, to: data.toBranchId },
      })
      touch(transfer.id)
      return { id: transfer.id, number: transfer.number }
    },
    'Transfer requested.',
  )
}

/** Approve reserves stock at the source; dispatch is what actually sends it. */
export async function approveTransferAction(transferId: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.TRANSFER_APPROVE)
    const transfer = await approveTransfer({ restaurantId: user.restaurantId, transferId, userId: user.id })
    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.TRANSFER_APPROVED, entity: 'StockTransfer', entityId: transfer.id,
      after: { number: transfer.number },
    })
    touch(transferId)
    return { id: transfer.id }
  })
}

export async function dispatchTransferAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({
      transferId: z.string().min(1),
      sent: z.array(z.object({
        lineId: z.string().min(1),
        quantity: z.coerce.number().min(0).max(1_000_000),
      })).optional(),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TRANSFER_DISPATCH)
      const transfer = await dispatchTransfer({
        restaurantId: user.restaurantId,
        transferId: data.transferId,
        sent: data.sent,
        userId: user.id,
      })
      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.TRANSFER_DISPATCHED, entity: 'StockTransfer', entityId: transfer.id,
        after: { number: transfer.number },
      })
      touch(data.transferId)
      return { id: transfer.id }
    },
    'Dispatched — stock has left.',
  )
}

export async function receiveTransferAction(
  input: unknown,
): Promise<ActionResult<{ id: string; variances: number }>> {
  return runAction(
    z.object({
      transferId: z.string().min(1),
      lines: z.array(z.object({
        lineId: z.string().min(1),
        receivedQty: z.coerce.number().min(0).max(1_000_000),
        varianceReason: z.enum(REASONS).optional(),
        varianceNote: z.string().trim().max(200).optional().or(z.literal('')),
      })).min(1),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TRANSFER_RECEIVE)
      const result = await receiveTransfer({
        restaurantId: user.restaurantId,
        transferId: data.transferId,
        userId: user.id,
        lines: data.lines.map((l) => ({
          lineId: l.lineId,
          receivedQty: l.receivedQty,
          varianceReason: l.varianceReason ?? null,
          varianceNote: l.varianceNote || null,
        })),
      })
      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.TRANSFER_RECEIVED, entity: 'StockTransfer', entityId: result.transfer.id,
        after: { number: result.transfer.number, variances: result.variances },
      })
      touch(data.transferId)
      return { id: result.transfer.id, variances: result.variances }
    },
    'Received into stock.',
  )
}

export async function closeTransferAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({
      transferId: z.string().min(1),
      status: z.enum(['REJECTED', 'CANCELLED']),
      reason: z.string().trim().max(200).optional().or(z.literal('')),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TRANSFER_APPROVE)
      const transfer = await closeTransfer({
        restaurantId: user.restaurantId,
        transferId: data.transferId,
        status: data.status,
        reason: data.reason || null,
        userId: user.id,
      })
      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.TRANSFER_CLOSED, entity: 'StockTransfer', entityId: transfer.id,
        after: { number: transfer.number, status: data.status },
      })
      touch(data.transferId)
      return { id: transfer.id }
    },
    'Transfer closed.',
  )
}
