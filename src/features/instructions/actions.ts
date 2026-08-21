'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { cancelInstruction, completeInstruction, createInstruction } from './service'

/*
 * Nothing but async functions may be exported from a 'use server' module.
 *
 * Exporting a Zod schema from one of these files is not a lint complaint — it
 * breaks every action in the file at runtime, and it did: four features in this
 * app were silently dead for weeks because a schema sat beside them. The
 * schemas here are deliberately const, not exported, and `no-bad-server-exports`
 * checks that they stay that way.
 */
const instructionSchema = z.object({
  branchId: z.string().min(1).optional().or(z.literal('')),
  title: z.string().trim().min(3, 'Say what needs doing').max(120),
  body: z.string().trim().max(1000).optional().or(z.literal('')),
  priority: z.enum(['NORMAL', 'URGENT']).default('NORMAL'),
  dueAt: z.string().optional().or(z.literal('')),
})

const completeSchema = z.object({
  instructionId: z.string().min(1),
  note: z.string().trim().max(300).optional().or(z.literal('')),
})

function touch() {
  revalidatePath('/dashboard/tasks')
  revalidatePath('/dashboard')
}

export async function createInstructionAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    instructionSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.DASHBOARD_VIEW)

      const instruction = await createInstruction({
        restaurantId: user.restaurantId,
        user,
        branchId: data.branchId || null,
        title: data.title,
        body: data.body || null,
        priority: data.priority,
        dueAt: data.dueAt ? new Date(data.dueAt) : null,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.INSTRUCTION_CREATED,
        entity: 'BranchInstruction',
        entityId: instruction.id,
        after: { title: instruction.title, branch: instruction.branch?.name ?? 'All locations' },
      })

      touch()
      return { id: instruction.id }
    },
    'Instruction sent.',
  )
}

export async function completeInstructionAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    completeSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.DASHBOARD_VIEW)

      const instruction = await completeInstruction({
        restaurantId: user.restaurantId,
        user,
        instructionId: data.instructionId,
        note: data.note || null,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.INSTRUCTION_COMPLETED,
        entity: 'BranchInstruction',
        entityId: instruction.id,
        after: { title: instruction.title, note: data.note || null },
      })

      touch()
      return { id: instruction.id }
    },
    'Marked done.',
  )
}

export async function cancelInstructionAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({ instructionId: z.string().min(1) }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.DASHBOARD_VIEW)

      const instruction = await cancelInstruction({
        restaurantId: user.restaurantId,
        user,
        instructionId: data.instructionId,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.INSTRUCTION_CANCELLED,
        entity: 'BranchInstruction',
        entityId: instruction.id,
        after: { title: instruction.title },
      })

      touch()
      return { id: instruction.id }
    },
    'Withdrawn.',
  )
}
