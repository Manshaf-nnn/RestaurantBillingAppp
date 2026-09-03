import 'server-only'

import { NotFoundError, ValidationError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

/**
 * Accountant notes (acCal.md §17): a short signed remark pinned to a
 * financial record. Append-only by construction — there is no update and no
 * delete anywhere in this module; a wrong note is answered with another
 * note, the way a paper daybook works.
 *
 * The same rows carry issue acknowledgements (§7): a note with
 * entity 'issue' and the check key as its id is the acknowledgement.
 */

export const NOTE_ENTITIES = [
  'invoice',
  'order',
  'payment',
  'outgoingPayment',
  'issue',
  'bankLine',
] as const

export type NoteEntity = (typeof NOTE_ENTITIES)[number]

/** The note must point at a real row of ours — never at another tenant's. */
async function assertTargetExists(restaurantId: string, entity: NoteEntity, entityId: string) {
  // Issue keys are check names, not rows; they are validated by shape alone.
  if (entity === 'issue') {
    if (!/^[a-z][a-z0-9-]{2,60}$/.test(entityId)) {
      throw new ValidationError('That is not an issue key.')
    }
    return
  }
  const found =
    entity === 'invoice'
      ? await prisma.invoice.findFirst({ where: { id: entityId, restaurantId }, select: { id: true } })
      : entity === 'order'
        ? await prisma.order.findFirst({ where: { id: entityId, restaurantId }, select: { id: true } })
        : entity === 'payment'
          ? await prisma.payment.findFirst({ where: { id: entityId, restaurantId }, select: { id: true } })
          : entity === 'outgoingPayment'
            ? await prisma.outgoingPayment.findFirst({ where: { id: entityId, restaurantId }, select: { id: true } })
            : await prisma.bankStatementLine.findFirst({ where: { id: entityId, restaurantId }, select: { id: true } })
  if (!found) throw new NotFoundError('That record was not found.')
}

export async function addNote(params: {
  restaurantId: string
  branchId?: string | null
  entity: NoteEntity
  entityId: string
  body: string
  authorId: string
  authorName: string
}) {
  const body = params.body.trim()
  if (body.length === 0) throw new ValidationError('A note must say something.')
  if (body.length > 500) throw new ValidationError('Keep a note under 500 characters.')

  await assertTargetExists(params.restaurantId, params.entity, params.entityId)

  return prisma.accountantNote.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId ?? null,
      entity: params.entity,
      entityId: params.entityId,
      body,
      authorId: params.authorId,
      authorName: params.authorName,
    },
  })
}

export async function listNotes(params: {
  restaurantId: string
  entity: NoteEntity
  entityId: string
}) {
  return prisma.accountantNote.findMany({
    where: { restaurantId: params.restaurantId, entity: params.entity, entityId: params.entityId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
}

/**
 * The latest acknowledgement per issue key — the Issues screen shows a
 * warning as "acknowledged" only while its count has not moved since.
 */
export async function latestIssueNotes(restaurantId: string) {
  const notes = await prisma.accountantNote.findMany({
    where: { restaurantId, entity: 'issue' },
    orderBy: { createdAt: 'desc' },
  })
  const byKey = new Map<string, (typeof notes)[number]>()
  for (const note of notes) {
    if (!byKey.has(note.entityId)) byKey.set(note.entityId, note)
  }
  return byKey
}
