import { prisma } from '@/server/db/prisma'

export interface ShiftNoteView {
  id: string
  body: string
  authorName: string
  createdAt: string
}

/** Open (unresolved) handover notes, newest first. */
export async function listShiftNotes(restaurantId: string): Promise<ShiftNoteView[]> {
  const notes = await prisma.shiftNote.findMany({
    where: { restaurantId, resolved: false },
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
