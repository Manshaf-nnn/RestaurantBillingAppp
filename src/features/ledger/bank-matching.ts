import 'server-only'

import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { hashFile, readStatementRows, type ParsedLine } from './bank-import'

/**
 * Matching a bank line to what the system already knows (acCal.md §6).
 *
 * The rules are deliberately conservative, because a wrong match is a lie
 * that survives in the books:
 *   • the amount must be EXACT — never "close enough"
 *   • direction must agree: money in matches a customer payment, money out
 *     matches a supplier or expense payment
 *   • the date must be within five days either way
 *   • a reference appearing in the bank's narration is strong evidence, but
 *     never on its own enough without the amount
 * Only the best candidate is offered, and a person accepts it. Nothing is
 * auto-matched behind anyone's back.
 */

const WINDOW_DAYS = 5
const DAY = 86_400_000

export type MatchType = 'PAYMENT' | 'SUPPLIER_PAYMENT' | 'OUTGOING_PAYMENT'

export interface MatchCandidate {
  type: MatchType
  id: string
  label: string
  amount: number
  date: Date
  reference: string | null
  score: number
  href: string
}

function scoreOf(params: {
  lineDate: Date
  description: string
  lineReference: string | null
  candidateDate: Date
  candidateReference: string | null
}): number {
  const daysApart = Math.abs(params.lineDate.getTime() - params.candidateDate.getTime()) / DAY
  let score = 100 - Math.round(daysApart) * 10
  const haystack = `${params.description} ${params.lineReference ?? ''}`.toLowerCase()
  const needle = (params.candidateReference ?? '').trim().toLowerCase()
  if (needle.length >= 4 && haystack.includes(needle)) score += 25
  return score
}

/** The best system record a bank line could be, or null when nothing fits. */
export async function suggestMatch(params: {
  restaurantId: string
  line: { id: string; lineDate: Date; description: string; reference: string | null; amount: number }
}): Promise<MatchCandidate | null> {
  const { restaurantId, line } = params
  const from = new Date(line.lineDate.getTime() - WINDOW_DAYS * DAY)
  const to = new Date(line.lineDate.getTime() + WINDOW_DAYS * DAY)
  const magnitude = Math.abs(line.amount)
  const moneyIn = line.amount > 0

  // Already-matched records must not be offered twice.
  const taken = await prisma.bankStatementLine.findMany({
    where: { restaurantId, status: 'MATCHED', matchedId: { not: null } },
    select: { matchedType: true, matchedId: true },
  })
  const isTaken = (type: MatchType, id: string) =>
    taken.some((row) => row.matchedType === type && row.matchedId === id)

  const candidates: MatchCandidate[] = []

  if (moneyIn) {
    // Money arriving is a guest's non-cash payment reaching the account.
    const payments = await prisma.payment.findMany({
      where: {
        restaurantId,
        status: { in: ['PAID', 'REFUNDED'] },
        method: { not: 'CASH' },
        amount: magnitude,
        paidAt: { gte: from, lte: to },
      },
      select: {
        id: true, amount: true, paidAt: true, reference: true, orderId: true,
        order: { select: { orderNumber: true } },
      },
      take: 25,
    })
    for (const payment of payments) {
      if (isTaken('PAYMENT', payment.id) || !payment.paidAt) continue
      candidates.push({
        type: 'PAYMENT',
        id: payment.id,
        label: `Bill ${payment.order?.orderNumber ?? ''} — customer payment`.trim(),
        amount: payment.amount,
        date: payment.paidAt,
        reference: payment.reference,
        score: scoreOf({
          lineDate: line.lineDate,
          description: line.description,
          lineReference: line.reference,
          candidateDate: payment.paidAt,
          candidateReference: payment.reference ?? payment.order?.orderNumber ?? null,
        }),
        href: `/dashboard/orders/${payment.orderId}`,
      })
    }
  } else {
    const [supplierPayments, outgoing] = await Promise.all([
      prisma.supplierPayment.findMany({
        where: {
          restaurantId,
          method: { not: 'CASH' },
          amount: magnitude,
          paidAt: { gte: from, lte: to },
        },
        select: {
          id: true, amount: true, paidAt: true, reference: true, supplierId: true,
          supplier: { select: { name: true } },
        },
        take: 25,
      }),
      prisma.outgoingPayment.findMany({
        where: {
          restaurantId,
          status: 'PAID',
          method: { not: 'CASH' },
          amount: magnitude,
          paymentDate: { gte: from, lte: to },
        },
        select: { id: true, number: true, amount: true, paymentDate: true, reference: true, description: true },
        take: 25,
      }),
    ])

    for (const payment of supplierPayments) {
      if (isTaken('SUPPLIER_PAYMENT', payment.id)) continue
      candidates.push({
        type: 'SUPPLIER_PAYMENT',
        id: payment.id,
        label: `Paid ${payment.supplier?.name ?? 'supplier'}`,
        amount: payment.amount,
        date: payment.paidAt,
        reference: payment.reference,
        score: scoreOf({
          lineDate: line.lineDate,
          description: line.description,
          lineReference: line.reference,
          candidateDate: payment.paidAt,
          candidateReference: payment.reference,
        }),
        href: `/dashboard/suppliers/${payment.supplierId}`,
      })
    }
    for (const payment of outgoing) {
      if (isTaken('OUTGOING_PAYMENT', payment.id)) continue
      candidates.push({
        type: 'OUTGOING_PAYMENT',
        id: payment.id,
        label: `${payment.number} — ${payment.description}`,
        amount: payment.amount,
        date: payment.paymentDate,
        reference: payment.reference,
        score: scoreOf({
          lineDate: line.lineDate,
          description: line.description,
          lineReference: line.reference,
          candidateDate: payment.paymentDate,
          candidateReference: payment.reference ?? payment.number,
        }),
        href: '/dashboard/accounting/payments',
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0] ?? null
}

export async function importStatement(params: {
  restaurantId: string
  branchId?: string | null
  fileName: string
  content: string
  rows: string[][]
  currencyFactor: number
  uploadedById: string
  uploadedByName: string
}) {
  const { restaurantId, rows, currencyFactor } = params
  const { lines, skipped } = readStatementRows({ restaurantId, rows, currencyFactor })
  const importHash = hashFile(params.content)

  const already = await prisma.bankStatement.findFirst({
    where: { restaurantId, importHash },
    select: { id: true, fileName: true, createdAt: true },
  })
  if (already) {
    throw new ConflictError(
      `That exact file was already imported on ${already.createdAt.toLocaleDateString()} as "${already.fileName}".`,
    )
  }

  // A line whose hash exists in an EARLIER statement is the same transaction
  // arriving twice — flagged, not silently dropped, so a person decides.
  const hashes = lines.map((line) => line.lineHash)
  const seen = await prisma.bankStatementLine.findMany({
    where: { restaurantId, lineHash: { in: hashes } },
    select: { lineHash: true },
  })
  const seenHashes = new Set(seen.map((row) => row.lineHash))

  const statement = await prisma.bankStatement.create({
    data: {
      restaurantId,
      branchId: params.branchId ?? null,
      fileName: params.fileName,
      importHash,
      lineCount: lines.length,
      uploadedById: params.uploadedById,
      uploadedByName: params.uploadedByName,
      lines: {
        create: lines.map((line: ParsedLine) => ({
          restaurantId,
          lineDate: line.lineDate,
          description: line.description,
          reference: line.reference,
          amount: line.amount,
          lineHash: line.lineHash,
          status: seenHashes.has(line.lineHash) ? ('DUPLICATE' as const) : ('UNMATCHED' as const),
        })),
      },
    },
    select: { id: true, lineCount: true },
  })

  return {
    statementId: statement.id,
    imported: lines.length,
    duplicates: lines.filter((line) => seenHashes.has(line.lineHash)).length,
    skipped,
  }
}

/**
 * Accept a match. CAS on UNMATCHED so two people clicking at once resolve to
 * one winner, and a second check refuses giving one system record to two
 * bank lines — the mistake that quietly doubles a payment in the books.
 */
export async function acceptMatch(params: {
  restaurantId: string
  lineId: string
  type: MatchType
  targetId: string
  userId: string
}) {
  return prisma.$transaction(async (tx) => {
    const line = await tx.bankStatementLine.findFirst({
      where: { id: params.lineId, restaurantId: params.restaurantId },
      select: { id: true, status: true },
    })
    if (!line) throw new NotFoundError('That statement line was not found.')

    const clash = await tx.bankStatementLine.findFirst({
      where: {
        restaurantId: params.restaurantId,
        status: 'MATCHED',
        matchedType: params.type,
        matchedId: params.targetId,
        id: { not: params.lineId },
      },
      select: { id: true },
    })
    if (clash) {
      throw new ConflictError('That payment is already matched to another line on the statement.')
    }

    const updated = await tx.bankStatementLine.updateMany({
      where: { id: params.lineId, restaurantId: params.restaurantId, status: { in: ['UNMATCHED', 'DUPLICATE'] } },
      data: {
        status: 'MATCHED',
        matchedType: params.type,
        matchedId: params.targetId,
        matchedById: params.userId,
        matchedAt: new Date(),
      },
    })
    if (updated.count === 0) {
      throw new ConflictError('That line was already dealt with by somebody else.')
    }
    return { id: params.lineId }
  })
}

/** Undo a match, or set a line aside as not ours to reconcile. */
export async function setLineStatus(params: {
  restaurantId: string
  lineId: string
  status: 'UNMATCHED' | 'IGNORED'
  userId: string
}) {
  const updated = await prisma.bankStatementLine.updateMany({
    where: { id: params.lineId, restaurantId: params.restaurantId },
    data: {
      status: params.status,
      matchedType: null,
      matchedId: null,
      matchedById: params.status === 'IGNORED' ? params.userId : null,
      matchedAt: params.status === 'IGNORED' ? new Date() : null,
    },
  })
  if (updated.count === 0) throw new NotFoundError('That statement line was not found.')
  return { id: params.lineId }
}

/** The Bank tab's data: counts, and the lines still needing a decision. */
export async function getBankReconciliation(params: {
  restaurantId: string
  branchIds?: string[] | null
}) {
  const { restaurantId } = params
  const [counts, open, statements] = await Promise.all([
    prisma.bankStatementLine.groupBy({
      by: ['status'],
      where: { restaurantId },
      _count: true,
    }),
    prisma.bankStatementLine.findMany({
      where: { restaurantId, status: { in: ['UNMATCHED', 'DUPLICATE'] } },
      orderBy: { lineDate: 'desc' },
      take: 100,
    }),
    prisma.bankStatement.findMany({
      where: { restaurantId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, fileName: true, lineCount: true, createdAt: true, uploadedByName: true },
    }),
  ])

  const withSuggestions = await Promise.all(
    open.slice(0, 40).map(async (line) => ({
      line,
      suggestion: await suggestMatch({ restaurantId, line }),
    })),
  )

  const countOf = (status: string) => counts.find((row) => row.status === status)?._count ?? 0
  return {
    counts: {
      matched: countOf('MATCHED'),
      unmatched: countOf('UNMATCHED'),
      duplicate: countOf('DUPLICATE'),
      ignored: countOf('IGNORED'),
    },
    open: withSuggestions,
    statements,
  }
}

export { ValidationError }
