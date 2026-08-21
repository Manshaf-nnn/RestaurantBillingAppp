import 'server-only'
import { randomBytes } from 'node:crypto'

import { prisma, type TxClient } from '@/server/db/prisma'
import { hashPassword } from '@/server/auth/password'

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

/**
 * The sign-in code — a password a waiter can be handed on a card.
 *
 * Deliberately NOT the staff code. `W-0003` is a sequence, so a whole
 * restaurant's logins would be W-0001 upward and guessable in about twenty
 * attempts. Identity and credential are different jobs: the staff code names
 * who served table four, this one proves it is them.
 *
 * Eight characters from a 31-letter alphabet is roughly 40 bits — far past
 * anything the login rate limit and account lockout would let through, while
 * still short enough to read off a card. `O`/`0` and `I`/`1` are excluded
 * because these get read aloud and retyped at a busy counter.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateSignInCode(): string {
  const bytes = randomBytes(8)
  let code = ''
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  // Grouped for reading; the halves are joined again before checking.
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * The code IS the password.
 *
 * Hashed straight into `passwordHash`, so there is one authentication path and
 * the ordinary login form works with no special case. A second credential
 * checked separately would be a second thing to get wrong.
 *
 * The plaintext is kept alongside so the owner can reprint a lost card. That is
 * a real weakening of "never store a password" — but the alternative is an owner
 * who cannot help a waiter locked out mid-service, and the same secret is
 * already printed on a card in that person's pocket. Anyone who can read this
 * column is already an authenticated owner of this restaurant.
 */
export async function issueSignInCode(userId: string): Promise<string> {
  const code = generateSignInCode()
  await prisma.user.update({
    where: { id: userId },
    data: { signInCode: code, passwordHash: await hashPassword(code) },
  })
  return code
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
