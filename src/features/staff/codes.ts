import 'server-only'

import { prisma, type TxClient } from '@/server/db/prisma'

/**
 * Short staff codes.
 *
 * A restaurant does not think in database ids. It thinks "W-0003 served that
 * table". The code is what appears on a waiter link, on a printed docket and in
 * the owner's staff report, and it is unique per restaurant so two restaurants
 * can both have a W-0001 without either knowing.
 *
 * Derived from the highest issued code rather than a row count, so deleting
 * someone never causes the next hire to collide with them.
 */
export async function nextStaffCode(
  db: TxClient | typeof prisma,
  restaurantId: string,
): Promise<string> {
  const rows = await db.user.findMany({
    where: { restaurantId, staffCode: { startsWith: 'W-' } },
    orderBy: { staffCode: 'desc' },
    take: 1,
    select: { staffCode: true },
  })
  const last = Number(rows[0]?.staffCode?.slice(2) ?? 0)
  return `W-${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`
}

/** Resolve a code to the person, scoped to one restaurant. */
export async function findByStaffCode(restaurantId: string, code: string) {
  const trimmed = code.trim().toUpperCase()
  if (!trimmed) return null
  return prisma.user.findFirst({
    where: { restaurantId, staffCode: trimmed, isActive: true, deletedAt: null },
    select: { id: true, name: true, role: true, staffCode: true },
  })
}

/** Backfill anyone still without one — safe to call repeatedly. */
export async function ensureStaffCodes(restaurantId: string): Promise<number> {
  const missing = await prisma.user.findMany({
    where: { restaurantId, staffCode: null, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  let issued = 0
  for (const user of missing) {
    const code = await nextStaffCode(prisma, restaurantId)
    await prisma.user.update({ where: { id: user.id }, data: { staffCode: code } })
    issued += 1
  }
  return issued
}
