'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { NotFoundError } from '@/lib/errors'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { resolveBranchId } from '@/features/branches/service'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { shiftNoteSchema } from './schema'

/**
 * Handover notes belong to one site.
 *
 * This is the bug the owner reported in as many words: a note left by the
 * closing staff at Branch 01 turned up on Main Branch's screen. `ShiftNote` had
 * no branch column at all and `listShiftNotes` filtered on the restaurant
 * alone, so there was nothing to filter by. The column now exists and is
 * required; these two actions are the write half.
 */

/** Leave a note for the next shift. */
export async function addShiftNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    shiftNoteSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.ORDER_VIEW)

      /*
       * The author's own location, not a posted one. A handover is written by
       * somebody standing in the room, so there is no case where the branch
       * should come from the client — and taking it from the session means it
       * cannot be aimed at another site.
       */
      const branchId = await resolveBranchId({
        restaurantId: user.restaurantId,
        userBranchId: user.branchId,
      })

      const note = await prisma.shiftNote.create({
        data: {
          restaurantId: user.restaurantId,
          branchId,
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

    /*
     * Scoped in the `where`, not checked afterwards. `updateMany` with the
     * branch predicate means a note at another location matches nothing and
     * reports as not-found — the same answer a made-up id gets, which is what
     * someone probing ids should see.
     */
    const reach = visibleBranchIds({ role: user.role, branchId: user.branchId })
    const result = await prisma.shiftNote.updateMany({
      where: {
        id,
        restaurantId: user.restaurantId,
        ...(reach ? { branchId: { in: reach } } : {}),
      },
      data: { resolved: true },
    })
    if (result.count === 0) throw new NotFoundError('Note')
    revalidatePath('/dashboard/handover')
    return { id }
  })
}
