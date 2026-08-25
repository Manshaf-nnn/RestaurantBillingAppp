import 'server-only'

import type { CashRegister } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

/**
 * Tills.
 *
 * ── Why a branch was not enough ─────────────────────────────────────────────
 *
 * A drawer session used to belong to a branch and a person, which made the
 * uniqueness rule wrong in both directions at once: two cashiers could each
 * hold an open drawer at the same counter, and one cashier could not hold one
 * at two different sites. Neither matches a real floor. What a session actually
 * belongs to is a physical till, and that is this.
 *
 * ── Why nobody has to set them up ───────────────────────────────────────────
 *
 * Most restaurants have one counter per branch and no interest in the concept.
 * `ensureRegister` creates "Counter 1" the first time a branch needs one, the
 * picker only appears when a branch has more than one, and an owner who never
 * opens the settings screen never learns the word "register". The model exists
 * so the question "which drawer was short" has an answer when it matters, not
 * to add a step for everyone else.
 */

/** Registers at one branch, in display order. */
export async function listRegisters(params: {
  restaurantId: string
  branchId: string
  includeInactive?: boolean
}): Promise<CashRegister[]> {
  return prisma.cashRegister.findMany({
    where: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      ...(params.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
}

/**
 * The branch's register, creating "Counter 1" if it has none.
 *
 * Concurrency-safe: two cashiers opening a till at the same second both race to
 * create, one loses on the `(branchId, name)` unique index, and the loser reads
 * the winner's row rather than failing.
 */
export async function ensureRegister(params: {
  restaurantId: string
  branchId: string
}): Promise<CashRegister> {
  const existing = await prisma.cashRegister.findFirst({
    where: { restaurantId: params.restaurantId, branchId: params.branchId, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  if (existing) return existing

  try {
    return await prisma.cashRegister.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        name: 'Counter 1',
      },
    })
  } catch {
    const raced = await prisma.cashRegister.findFirst({
      where: { restaurantId: params.restaurantId, branchId: params.branchId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    if (raced) return raced
    throw new AppError('Could not set up a till for this branch', 500, 'REGISTER_SETUP_FAILED')
  }
}

/**
 * Turn a possibly-untrusted register id into one that really is at this branch.
 *
 * The branch check is the point. A register id posted from the browser is
 * otherwise a way to attach a session to another site's till, and every
 * downstream branch check reads the *session*, so it would then agree.
 */
export async function resolveRegisterId(params: {
  restaurantId: string
  branchId: string
  requestedRegisterId?: string | null
}): Promise<string> {
  if (params.requestedRegisterId) {
    const owned = await prisma.cashRegister.findFirst({
      where: {
        id: params.requestedRegisterId,
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        isActive: true,
      },
      select: { id: true },
    })
    if (owned) return owned.id
    throw new NotFoundError('Till')
  }
  const register = await ensureRegister(params)
  return register.id
}

/**
 * Registers across several branches at once, for the screen that asks a cashier
 * to pick a branch and then a till.
 *
 * `branchIds` of `[]` means "confined with nowhere to look" and returns
 * nothing, which is the same rule `visibleBranchIds` sets everywhere else.
 */
export async function listRegistersForBranches(params: {
  restaurantId: string
  branchIds: string[]
}): Promise<CashRegister[]> {
  if (params.branchIds.length === 0) return []
  return prisma.cashRegister.findMany({
    where: {
      restaurantId: params.restaurantId,
      branchId: { in: params.branchIds },
      isActive: true,
    },
    orderBy: [{ branchId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  })
}

/** One till, refusing ids belonging to another restaurant. */
export async function requireRegister(
  restaurantId: string,
  registerId: string,
): Promise<CashRegister> {
  const register = await prisma.cashRegister.findFirst({
    where: { id: registerId, restaurantId },
  })
  if (!register) throw new NotFoundError('Till')
  return register
}

export async function createRegister(params: {
  restaurantId: string
  branchId: string
  name: string
}): Promise<CashRegister> {
  const name = params.name.trim()
  if (name.length < 1) throw new AppError('Give the till a name', 400, 'REGISTER_NO_NAME')

  const branch = await prisma.branch.findFirst({
    where: { id: params.branchId, restaurantId: params.restaurantId, deletedAt: null },
    select: { id: true },
  })
  if (!branch) throw new NotFoundError('Branch')

  const clash = await prisma.cashRegister.findFirst({
    where: { branchId: params.branchId, name },
    select: { id: true },
  })
  if (clash) {
    throw new AppError('There is already a till with that name here', 409, 'REGISTER_DUPLICATE')
  }

  const count = await prisma.cashRegister.count({ where: { branchId: params.branchId } })
  return prisma.cashRegister.create({
    data: { restaurantId: params.restaurantId, branchId: params.branchId, name, sortOrder: count },
  })
}

/**
 * Switch a till off.
 *
 * Refused while a session is open on it, for the same reason a branch cannot be
 * deactivated with an open drawer: the money in it still has to be counted by
 * the person who is responsible for it.
 */
export async function setRegisterActive(params: {
  restaurantId: string
  registerId: string
  isActive: boolean
}): Promise<CashRegister> {
  const register = await prisma.cashRegister.findFirst({
    where: { id: params.registerId, restaurantId: params.restaurantId },
  })
  if (!register) throw new NotFoundError('Till')

  if (!params.isActive) {
    const open = await prisma.cashDrawerSession.count({
      where: { registerId: register.id, status: { in: ['OPEN', 'PENDING_REVIEW'] } },
    })
    if (open > 0) {
      throw new AppError(
        'Close the drawer on this till before switching it off',
        409,
        'REGISTER_STILL_BUSY',
      )
    }
  }

  return prisma.cashRegister.update({
    where: { id: register.id },
    data: { isActive: params.isActive },
  })
}

/**
 * The next session number, e.g. "CD-2026-000123".
 *
 * Per restaurant and per calendar year, so the sequence restarts each January
 * and reads like the year's history. Counting existing rows would collide the
 * moment two cashiers opened at once, so the number is derived from the highest
 * one already issued and the unique index on `sessionNumber` is the backstop —
 * `openDrawer` retries on a clash.
 */
export async function nextSessionNumber(restaurantId: string, when: Date): Promise<string> {
  const year = when.getFullYear()
  const prefix = `CD-${year}-`

  const latest = await prisma.cashDrawerSession.findFirst({
    where: { restaurantId, sessionNumber: { startsWith: prefix } },
    orderBy: { sessionNumber: 'desc' },
    select: { sessionNumber: true },
  })

  const last = latest ? Number(latest.sessionNumber.slice(prefix.length)) : 0
  const next = Number.isFinite(last) ? last + 1 : 1
  return `${prefix}${String(next).padStart(6, '0')}`
}
