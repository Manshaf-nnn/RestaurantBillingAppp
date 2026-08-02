'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { shiftNoteSchema } from './schema'

/** Leave a note for the next shift. */
export async function addShiftNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    shiftNoteSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.ORDER_VIEW)
      const note = await prisma.shiftNote.create({
        data: {
          restaurantId: user.restaurantId,
          body: data.body,
          authorId: user.id,
          authorName: user.name,
        },
      })
      revalidatePath('/dashboard/handover')
      return { id: note.id }
    },
    'Note left for the next shift.',
  )
}

/** Mark a handover note as done. */
export async function resolveShiftNote(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.ORDER_VIEW)
    const result = await prisma.shiftNote.updateMany({
      where: { id, restaurantId: user.restaurantId },
      data: { resolved: true },
    })
    if (result.count === 0) throw new NotFoundError('Note')
    revalidatePath('/dashboard/handover')
    return { id }
  })
}
