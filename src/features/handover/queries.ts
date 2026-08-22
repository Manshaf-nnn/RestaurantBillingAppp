import { prisma } from '@/server/db/prisma'

export interface ShiftNoteView {
  id: string
  body: string
  authorName: string
  createdAt: string
}

/**
 * Open (unresolved) handover notes, newest first.
 *
 * `branchIds` follows the convention used everywhere else in this codebase:
 * `null` means no restriction, an array narrows, and an EMPTY array must return
 * nothing rather than everything. Reading `[]` as "no filter" is the mistake
 * that let an unassigned warehouse worker see every transfer in the business,
 * so it is spelled out here rather than left to a truthy check.
 */
export async function listShiftNotes(
  restaurantId: string,
  branchIds?: string[] | null,
): Promise<ShiftNoteView[]> {
  const notes = await prisma.shiftNote.findMany({
    where: {
      restaurantId,
      resolved: false,
      ...(branchIds ? { branchId: { in: branchIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, body: true, authorName: true, createdAt: true },
  })
  return notes.map((n) => ({
    id: n.id,
    body: n.body,
    authorName: n.authorName,
    createdAt: n.createdAt.toISOString(),
  }))
}
