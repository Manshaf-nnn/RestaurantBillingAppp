'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { notifyLocation } from '@/features/instructions/service'
import { assertApproved, requestApproval } from '@/features/approvals/service'
import { prisma } from '@/server/db/prisma'
import {
  approveTransfer, assertTransferSide, closeTransfer, completeTransfer, dispatchTransfer,
  receiveTransfer, recallTransfer,
  requestTransfer, transferEnds,
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
      /*
       * Optional shelves. The service has always supported a same-branch move
       * between two storage areas — Main Store to Cold Room — and validates that
       * each shelf belongs to the branch beside it. These two fields were simply
       * missing from the schema, so the form could not express it and picking one
       * branch on both sides failed with "choose a different destination", which
       * described the shape of the bug rather than anything the user did.
       */
      fromStorageId: z.string().min(1).optional().or(z.literal('')),
      toStorageId: z.string().min(1).optional().or(z.literal('')),
      notes: z.string().trim().max(300).optional().or(z.literal('')),
      lines: z.array(z.object({
        itemId: z.string().min(1),
        quantity: z.coerce.number().positive().max(1_000_000),
      })).min(1, 'Add at least one item'),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TRANSFER_REQUEST)
      /*
       * Either end. This used to demand access to the SOURCE, which meant a
       * branch manager could not ask the warehouse for anything — the one thing
       * the screen exists for. Asking to pull stock in is as legitimate as
       * offering to push it out.
       */
      assertTransferSide(user, { fromBranchId: data.fromBranchId, toBranchId: data.toBranchId }, 'EITHER')

      // Names for the approval queue, so the owner reads "Main → Kandy" rather
      // than two cuids.
      const named = await prisma.branch.findMany({
        where: { id: { in: [data.fromBranchId, data.toBranchId] }, restaurantId: user.restaurantId },
        select: { id: true, name: true },
      })
      const nameOf = (id: string) => named.find((b) => b.id === id)?.name ?? 'another location'
      const ends = { from: nameOf(data.fromBranchId), to: nameOf(data.toBranchId) }

      const transfer = await requestTransfer({
        restaurantId: user.restaurantId,
        fromBranchId: data.fromBranchId,
        toBranchId: data.toBranchId,
        fromStorageId: data.fromStorageId || null,
        toStorageId: data.toStorageId || null,
        notes: data.notes || null,
        lines: data.lines,
        userId: user.id,
      })
      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.TRANSFER_REQUESTED, entity: 'StockTransfer', entityId: transfer.id,
        after: { number: transfer.number, from: data.fromBranchId, to: data.toBranchId },
      })
      /*
       * Tell the other end. A request that only appears on a list nobody has
       * opened is not a request — the warehouse has no reason to look, so the
       * van never leaves and the branch concludes the feature is broken.
       */
      await notifyLocation({
        restaurantId: user.restaurantId,
        branchId: data.fromBranchId,
        title: `Stock requested: ${transfer.number}`,
        body: `${user.name} has asked for ${data.lines.length} item${data.lines.length === 1 ? '' : 's'}.`,
        data: { transferId: transfer.id, href: `/dashboard/transfers/${transfer.id}` },
      })

      /*
       * A cross-branch move needs the owner's word.
       *
       * This is the wire that has never been connected. `ApprovalRequest`, the
       * queue component, `/dashboard/approvals` and `decideApproval` were all
       * built and correct, and nothing in the application ever called
       * `requestApproval` — so the Approvals tab rendered, empty, for ever.
       *
       * Only cross-branch. Shuffling stock between two shelves inside one site
       * is that site's own business, and routing it to the owner would bury the
       * queue in exactly the noise that makes people stop reading it.
       */
      if (data.fromBranchId !== data.toBranchId) {
        await requestApproval({
          restaurantId: user.restaurantId,
          // The SOURCE branch, because approval reserves the source's stock and
          // it is the source that gives something up.
          branchId: data.fromBranchId,
          kind: 'STOCK_TRANSFER',
          entity: 'StockTransfer',
          entityId: transfer.id,
          reason: `${transfer.number}: ${data.lines.length} item${data.lines.length === 1 ? '' : 's'} from ${ends.from} to ${ends.to}`,
          payload: {
            number: transfer.number,
            fromBranchId: data.fromBranchId,
            toBranchId: data.toBranchId,
            lines: data.lines.length,
          },
          userId: user.id,
        })
      }

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
    // Approval reserves stock at the sending location, so that is whose call it is.
    const ends = await transferEnds(user.restaurantId, transferId)
    assertTransferSide(user, ends, 'SOURCE')

    /*
     * A cross-branch move waits for the owner.
     *
     * The permission answers "may this person approve transfers"; it never
     * answered "may they approve stock leaving the business's own network". A
     * branch manager holds TRANSFER_APPROVE and could sign off pulling twenty
     * kilos out of the warehouse without anyone above them seeing it.
     *
     * `assertApproved` reads the request raised when the transfer was
     * submitted, and refuses with APPROVAL_REQUIRED until an owner or admin has
     * ruled on it. A move between two shelves in one branch raises no request
     * and needs none, which is why this is not asked in that case.
     */
    if (ends.fromBranchId !== ends.toBranchId) {
      await assertApproved({
        restaurantId: user.restaurantId,
        entity: 'StockTransfer',
        entityId: transferId,
        kind: 'STOCK_TRANSFER',
      })
    }

    const transfer = await approveTransfer({ restaurantId: user.restaurantId, transferId, userId: user.id })
    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.TRANSFER_APPROVED, entity: 'StockTransfer', entityId: transfer.id,
      after: { number: transfer.number },
    })
    await notifyLocation({
      restaurantId: user.restaurantId,
      branchId: ends.toBranchId,
      title: `Transfer approved: ${transfer.number}`,
      body: `${user.name} approved it. The stock is reserved and will be sent.`,
      data: { transferId: transfer.id, href: `/dashboard/transfers/${transfer.id}` },
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
      // The stock leaves that building; nobody else gets to send it.
      const ends = await transferEnds(user.restaurantId, data.transferId)
      assertTransferSide(user, ends, 'SOURCE')
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
      await notifyLocation({
        restaurantId: user.restaurantId,
        branchId: ends.toBranchId,
        title: `On its way: ${transfer.number}`,
        body: `${user.name} dispatched it. Receive it when the van arrives — nothing is on your shelf until you do.`,
        data: { transferId: transfer.id, href: `/dashboard/transfers/${transfer.id}` },
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
      // Only the people unloading the van can say what came off it.
      const ends = await transferEnds(user.restaurantId, data.transferId)
      assertTransferSide(user, ends, 'DESTINATION')
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
      /*
       * The sending location hears about it either way, and hears about a
       * shortfall loudly. Stock that left one building and did not arrive at
       * the other is the single most expensive thing this module can detect,
       * and it is worthless if only the person unloading the van knows.
       */
      await notifyLocation({
        restaurantId: user.restaurantId,
        branchId: ends.fromBranchId,
        title:
          result.variances > 0
            ? `Short on arrival: ${result.transfer.number}`
            : `Received in full: ${result.transfer.number}`,
        body:
          result.variances > 0
            ? `${user.name} received it with ${result.variances} line${result.variances === 1 ? '' : 's'} not matching what was sent.`
            : `${user.name} received everything that was sent.`,
        data: { transferId: result.transfer.id, href: `/dashboard/transfers/${result.transfer.id}` },
      })

      touch(data.transferId)
      return { id: result.transfer.id, variances: result.variances }
    },
    'Received into stock.',
  )
}

/**
 * Accept a delivery that arrived short or damaged.
 *
 * The stock has already moved; this is the human step that closes the paperwork
 * on the shortfall. Only the destination can do it — they are the ones who
 * counted what turned up.
 */
export async function completeTransferAction(transferId: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.TRANSFER_RECEIVE)
    const ends = await transferEnds(user.restaurantId, transferId)
    assertTransferSide(user, ends, 'DESTINATION')

    const transfer = await completeTransfer({
      restaurantId: user.restaurantId,
      transferId,
      userId: user.id,
    })
    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.TRANSFER_CLOSED, entity: 'StockTransfer', entityId: transfer.id,
      after: { number: transfer.number, status: 'COMPLETED', variancesAccepted: true },
    })
    await notifyLocation({
      restaurantId: user.restaurantId,
      branchId: ends.fromBranchId,
      title: `Variance accepted: ${transfer.number}`,
      body: `${user.name} has signed off the shortfall.`,
      data: { transferId: transfer.id, href: `/dashboard/transfers/${transfer.id}` },
    })

    touch(transfer.id)
    return { id: transfer.id }
  }, 'Transfer completed.')
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
      // Either side may call it off — the sender changed their mind, or the
      // receiver no longer needs it.
      const ends = await transferEnds(user.restaurantId, data.transferId)
      assertTransferSide(user, ends, 'EITHER')
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
      // Whichever end did not close it needs to know it is not coming.
      await notifyLocation({
        restaurantId: user.restaurantId,
        branchId: ends.toBranchId,
        title: `${data.status === 'REJECTED' ? 'Rejected' : 'Cancelled'}: ${transfer.number}`,
        body: `${user.name} closed it${data.reason ? ` — ${data.reason}` : ''}.`,
        data: { transferId: transfer.id, href: `/dashboard/transfers/${transfer.id}` },
      })

      touch(data.transferId)
      return { id: transfer.id }
    },
    'Transfer closed.',
  )
}

/**
 * Bring a dispatched transfer home.
 *
 * The source side only — it is their stock coming back to their shelf, and the
 * destination has nothing to give up but a phantom inbound figure. `DISPATCH`
 * rather than `APPROVE` for the same reason: whoever could send it is whoever
 * can un-send it.
 */
export async function recallTransferAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({
      transferId: z.string().min(1),
      reason: z.string().trim().min(2, 'Say why it is coming back').max(200),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.TRANSFER_DISPATCH)
      const ends = await transferEnds(user.restaurantId, data.transferId)
      assertTransferSide(user, ends, 'SOURCE')

      const transfer = await recallTransfer({
        restaurantId: user.restaurantId,
        transferId: data.transferId,
        reason: data.reason,
        userId: user.id,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: ends.fromBranchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.TRANSFER_CLOSED,
        entity: 'StockTransfer',
        entityId: transfer.id,
        after: { number: transfer.number, status: 'CANCELLED', recalled: true, reason: data.reason },
      })

      // The destination was expecting this. Telling them is the whole point.
      await notifyLocation({
        restaurantId: user.restaurantId,
        branchId: ends.toBranchId,
        title: `Recalled: ${transfer.number}`,
        body: `${user.name} brought it back — ${data.reason}.`,
        data: { transferId: transfer.id, href: `/dashboard/transfers/${transfer.id}` },
      })

      touch(data.transferId)
      return { id: transfer.id }
    },
    'Recalled. The stock is back at the source.',
  )
}
