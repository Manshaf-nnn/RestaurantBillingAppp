import 'server-only'

import type { Branch } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'

/**
 * Branches (locations) for a restaurant.
 *
 * Multi-branch is opt-in and invisible to a single-location restaurant. Every
 * restaurant gets one branch marked `isDefault`, created on demand, so that
 * operational rows always have somewhere to belong and reports never have to
 * special-case "no branch". Existing rows keep `branchId = null` and are read
 * as belonging to the default branch, which is why no backfill is required and
 * nothing breaks for restaurants already running.
 *
 * A branch id arriving from the client is never trusted: `resolveBranchId`
 * re-reads it under the caller's own `restaurantId`, so a guessed id from
 * another tenant resolves to nothing rather than leaking across the boundary.
 */

export interface BranchSummary {
  id: string
  name: string
  code: string
  address: string | null
  phone: string | null
  isActive: boolean
  isDefault: boolean
}

const SUMMARY = {
  id: true,
  name: true,
  code: true,
  address: true,
  phone: true,
  isActive: true,
  isDefault: true,
} as const

/**
 * The restaurant's default branch, created if it does not exist yet.
 *
 * Idempotent and safe to call on any request path. Two concurrent callers can
 * race here, so the unique `[restaurantId, code]` constraint is the arbiter and
 * a duplicate-key loss is resolved by re-reading rather than failing.
 */
export async function ensureDefaultBranch(restaurantId: string): Promise<BranchSummary> {
  const existing = await prisma.branch.findFirst({
    where: { restaurantId, deletedAt: null, isDefault: true },
    select: SUMMARY,
  })
  if (existing) return existing

  try {
    return await prisma.branch.create({
      data: { restaurantId, name: 'Main', code: 'MAIN', isDefault: true },
      select: SUMMARY,
    })
  } catch {
    const raced = await prisma.branch.findFirst({
      where: { restaurantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: SUMMARY,
    })
    if (!raced) throw new AppError('Could not resolve a branch', 500, 'BRANCH_UNRESOLVED')
    return raced
  }
}

export async function listBranches(restaurantId: string): Promise<BranchSummary[]> {
  return prisma.branch.findMany({
    where: { restaurantId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: SUMMARY,
  })
}

/**
 * Turn a possibly-untrusted branch id into one this restaurant actually owns.
 *
 * Falls back to the user's home branch, then the restaurant default. Returns a
 * real id in every case so callers can write it straight onto a record.
 */
export async function resolveBranchId(params: {
  restaurantId: string
  requestedBranchId?: string | null
  userBranchId?: string | null
}): Promise<string> {
  for (const candidate of [params.requestedBranchId, params.userBranchId]) {
    if (!candidate) continue
    const owned = await prisma.branch.findFirst({
      where: {
        id: candidate,
        restaurantId: params.restaurantId,
        deletedAt: null,
        isActive: true,
      },
      select: { id: true },
    })
    if (owned) return owned.id
  }
  const fallback = await ensureDefaultBranch(params.restaurantId)
  return fallback.id
}

/** Read a branch, refusing ids belonging to another restaurant. */
export async function requireBranch(restaurantId: string, branchId: string): Promise<Branch> {
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, restaurantId, deletedAt: null },
  })
  if (!branch) throw new NotFoundError('Branch')
  return branch
}

export async function createBranch(params: {
  restaurantId: string
  name: string
  code: string
  address?: string | null
  phone?: string | null
}): Promise<BranchSummary> {
  const code = params.code.trim().toUpperCase()
  const clash = await prisma.branch.findFirst({
    where: { restaurantId: params.restaurantId, code, deletedAt: null },
    select: { id: true },
  })
  if (clash) throw new AppError(`Branch code ${code} is already used`, 409, 'BRANCH_CODE_TAKEN')

  // The first branch a restaurant creates becomes its default.
  const count = await prisma.branch.count({
    where: { restaurantId: params.restaurantId, deletedAt: null },
  })

  return prisma.branch.create({
    data: {
      restaurantId: params.restaurantId,
      name: params.name.trim(),
      code,
      address: params.address?.trim() || null,
      phone: params.phone?.trim() || null,
      isDefault: count === 0,
    },
    select: SUMMARY,
  })
}

export async function updateBranch(params: {
  restaurantId: string
  branchId: string
  name?: string
  address?: string | null
  phone?: string | null
  isActive?: boolean
}): Promise<BranchSummary> {
  await requireBranch(params.restaurantId, params.branchId)

  return prisma.branch.update({
    where: { id: params.branchId },
    data: {
      ...(params.name !== undefined ? { name: params.name.trim() } : {}),
      ...(params.address !== undefined ? { address: params.address?.trim() || null } : {}),
      ...(params.phone !== undefined ? { phone: params.phone?.trim() || null } : {}),
      ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
    },
    select: SUMMARY,
  })
}

/**
 * Make `branchId` the restaurant's default, clearing the previous one.
 *
 * Runs in a transaction because "exactly one default" is an invariant the
 * schema cannot express, and a half-applied swap would leave a restaurant with
 * either two defaults or none.
 */
export async function setDefaultBranch(restaurantId: string, branchId: string): Promise<void> {
  await requireBranch(restaurantId, branchId)
  await prisma.$transaction(async (tx: TxClient) => {
    await tx.branch.updateMany({ where: { restaurantId }, data: { isDefault: false } })
    await tx.branch.update({ where: { id: branchId }, data: { isDefault: true, isActive: true } })
  })
}
