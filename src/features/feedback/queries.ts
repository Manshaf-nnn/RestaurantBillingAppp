import { prisma } from '@/server/db/prisma'

export interface FeedbackComment {
  id: string
  rating: number
  comment: string | null
  tableNumber: string | null
  createdAt: string
}

export interface FeedbackOverview {
  total: number
  average: number
  counts: Record<1 | 2 | 3 | 4, number>
  happyPct: number
  recent: FeedbackComment[]
}

/** Owner-facing summary of anonymous guest feedback. */
export async function getFeedbackOverview(restaurantId: string): Promise<FeedbackOverview> {
  const [groups, recent] = await Promise.all([
    prisma.feedback.groupBy({ by: ['rating'], where: { restaurantId, category: 'FOOD' }, _count: true }),
    prisma.feedback.findMany({
      where: { restaurantId, category: 'FOOD', comment: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { id: true, rating: true, comment: true, tableNumber: true, createdAt: true },
    }),
  ])

  const counts: Record<1 | 2 | 3 | 4, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  let total = 0
  let sum = 0
  for (const g of groups) {
    const r = g.rating as 1 | 2 | 3 | 4
    if (r >= 1 && r <= 4) {
      counts[r] = g._count
      total += g._count
      sum += r * g._count
    }
  }
  const happy = counts[3] + counts[4]

  return {
    total,
    average: total ? sum / total : 0,
    counts,
    happyPct: total ? Math.round((happy / total) * 100) : 0,
    recent: recent.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      tableNumber: r.tableNumber,
      createdAt: r.createdAt.toISOString(),
    })),
  }
}
