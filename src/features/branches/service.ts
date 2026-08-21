import 'server-only'

import { Prisma, type Branch, type LocationType } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import type { OpeningHours } from '@/lib/opening-hours'
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
/**
 * Where a stock movement happened, resolved to a real location. Never null.
 *
 * This is the fix for the bug that made multi-location inventory meaningless.
 * Every entry point — receiving a purchase, an opening balance, a manual
 * movement, a stock count — used to write `branchId: user.branchId ?? null`.
 * `User.branchId` is not set by any screen in the app, so for an owner that is
 * always null, and `applyLocationDelta` discards a movement with no branch:
 *
 *     if (!params.branchId) return        // location-stock.ts
 *
 * The restaurant-wide total therefore rose while no `InventoryStock` row was
 * ever created. Every location's "Stock here" panel stayed empty for ever, and
 * the transfer builder — which reads `InventoryStock` — had nothing to offer.
 * Stock existed in the accounts and nowhere on any shelf.
 *
 * Falling back to the default branch is what makes the ledger's location
 * dimension trustworthy: a movement always names a place, so the per-branch sum
 * always reconciles to the restaurant total. A single-site restaurant that has
 * never thought about locations simply gets its one branch, silently.
 */
export async function resolveStockLocation(params: {
  restaurantId: string
  /** What the screen asked for, if it offered a choice. */
  requestedBranchId?: string | null
  /** The user's home location, when they have one. */
  userBranchId?: string | null
}): Promise<string> {
  return resolveBranchId(params)
}

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

/**
 * Change what a location is and how it is reached.
 *
 * Only the fields actually passed are written. That distinction is the whole
 * point: a caller that means to rename must not silently erase the address and
 * phone on its way past, which is what `updateLocationAction` did when it
 * forwarded `data.address ?? null` for a field the form had never sent.
 *
 * `openingHours` is the exception worth naming — `null` is a real value here,
 * meaning "this location keeps the restaurant's own hours", and it is stored as
 * a database NULL rather than the JSON literal `null` so that reading it back
 * is a plain emptiness check.
 */
export async function updateBranch(params: {
  restaurantId: string
  branchId: string
  name?: string
  type?: LocationType
  address?: string | null
  phone?: string | null
  isActive?: boolean
  openingHours?: OpeningHours | null
}): Promise<BranchSummary> {
  await requireBranch(params.restaurantId, params.branchId)

  return prisma.branch.update({
    where: { id: params.branchId },
    data: {
      ...(params.name !== undefined ? { name: params.name.trim() } : {}),
      ...(params.type !== undefined ? { type: params.type } : {}),
      ...(params.address !== undefined ? { address: params.address?.trim() || null } : {}),
      ...(params.phone !== undefined ? { phone: params.phone?.trim() || null } : {}),
      ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
      ...(params.openingHours !== undefined
        ? {
            openingHours:
              params.openingHours === null
                ? Prisma.DbNull
                : (params.openingHours as Prisma.InputJsonValue),
          }
        : {}),
    },
    select: SUMMARY,
  })
}

/**
 * Put someone in charge of a location, and keep the two facts from disagreeing.
 *
 * `Branch.managerId` on its own is only a caption. Scoping is decided by
 * `User.branchId` — `visibleBranchIds` reads it, and a MANAGER with none set is
 * treated as a group manager who sees every site. So naming Nimal as the Kandy
 * manager while leaving his own branch null would print "managed by Nimal" on
 * the Kandy page while Nimal's figures still covered the whole chain.
 *
 * Someone already tied to another location keeps that tie. The `branchId: null`
 * in the where clause is what enforces it, atomically: naming a manager is a
 * small act and it must not quietly move a person off the site they run.
 */
export async function setBranchManager(params: {
  restaurantId: string
  branchId: string
  managerId: string | null
}): Promise<void> {
  await requireBranch(params.restaurantId, params.branchId)

  await prisma.$transaction(async (tx: TxClient) => {
    await tx.branch.update({
      where: { id: params.branchId },
      data: { managerId: params.managerId },
    })
    if (params.managerId) {
      await tx.user.updateMany({
        where: {
          id: params.managerId,
          restaurantId: params.restaurantId,
          deletedAt: null,
          branchId: null,
        },
        data: { branchId: params.branchId },
      })
    }
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

/**
 * Create a location and settle who runs it, in one transaction.
 *
 * Two problems solved together.
 *
 * The first is that a location arrived with nobody in charge. The manager
 * picker only existed on the *edit* page, so setting one up meant: create the
 * location, leave, create a person on the Staff screen, come back, join the
 * two. Four screens for one decision, and in practice it was skipped — of the
 * twenty-four staff accounts in this database, two had a location.
 *
 * The second is that `createLocationAction` used to write twice — create the
 * branch, then immediately update it just to set `type`, because `createBranch`
 * had no type parameter. Two round trips, non-atomic, and a failure between
 * them left a location of the wrong kind.
 *
 * Everything below happens in one transaction, so a duplicate email or a bad
 * code cannot leave a half-made location or an orphaned account behind.
 *
 * A new manager is an ordinary `User` with `role: MANAGER` — the same record
 * the Staff screen produces, built from the same helpers. There is deliberately
 * no second kind of account: sign-in, codes and RBAC all keep working because
 * there is nothing new for them to know about.
 */
export async function createLocationWithManager(params: {
  restaurantId: string
  name: string
  code: string
  type: LocationType
  address?: string | null
  phone?: string | null
  manager:
    | { mode: 'NONE' }
    | { mode: 'EXISTING'; userId: string }
    | { mode: 'NEW'; name: string; email: string; phone?: string | null }
  /** Builds the credentials for a new account; injected so this file stays db-only. */
  issueCredentials?: () => Promise<{ signInCode: string; passwordHash: string }>
  nextStaffCode?: (tx: TxClient) => Promise<string>
}): Promise<{
  branch: Branch
  /** Present only when a new account was made, and only this once. */
  created: { userId: string; name: string; email: string; signInCode: string } | null
}> {
  const code = params.code.trim().toUpperCase()
  const email = params.manager.mode === 'NEW' ? params.manager.email.trim().toLowerCase() : null

  /*
   * Both uniqueness checks run before the transaction opens as well as inside
   * it. Outside gives a readable message; inside is what actually holds, since
   * two people can pass the outside check at the same moment.
   */
  const clash = await prisma.branch.findFirst({
    where: { restaurantId: params.restaurantId, code, deletedAt: null },
    select: { id: true },
  })
  if (clash) throw new AppError(`Location code ${code} is already used`, 409, 'BRANCH_CODE_TAKEN')

  if (email) {
    // The email unique index is GLOBAL, not per restaurant, so this has to be
    // an unscoped lookup or the constraint fires as an opaque 500 instead.
    const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (taken) {
      throw new AppError(
        `${email} already has an account — pick them from the list instead`,
        409,
        'MANAGER_EMAIL_TAKEN',
      )
    }
  }

  return prisma.$transaction(async (tx) => {
    // The first location a restaurant creates becomes its default.
    const existing = await tx.branch.count({
      where: { restaurantId: params.restaurantId, deletedAt: null },
    })

    const branch = await tx.branch.create({
      data: {
        restaurantId: params.restaurantId,
        name: params.name.trim(),
        code,
        type: params.type,
        address: params.address?.trim() || null,
        phone: params.phone?.trim() || null,
        isDefault: existing === 0,
      },
    })

    if (params.manager.mode === 'EXISTING') {
      const person = await tx.user.findFirst({
        where: {
          id: params.manager.userId,
          restaurantId: params.restaurantId,
          deletedAt: null,
        },
        select: { id: true, branchId: true },
      })
      if (!person) throw new NotFoundError('Manager')

      await tx.branch.update({ where: { id: branch.id }, data: { managerId: person.id } })

      /*
       * Only move them if they are not already running somewhere. Naming the
       * Colombo manager on a new Kandy record must not silently un-scope
       * Colombo — the same guard `setBranchManager` has carried since it was
       * written.
       */
      if (!person.branchId) {
        await tx.user.update({ where: { id: person.id }, data: { branchId: branch.id } })
      }

      return { branch, created: null }
    }

    if (params.manager.mode === 'NEW') {
      if (!params.issueCredentials || !params.nextStaffCode) {
        throw new AppError('Cannot issue credentials here', 500, 'NO_CREDENTIAL_ISSUER')
      }

      const { signInCode, passwordHash } = await params.issueCredentials()
      const staffCode = await params.nextStaffCode(tx)

      const person = await tx.user.create({
        data: {
          restaurantId: params.restaurantId,
          email: email!,
          name: params.manager.name.trim(),
          phone: params.manager.phone?.trim() || null,
          role: 'MANAGER',
          branchId: branch.id,
          staffCode,
          signInCode,
          passwordHash,
          // Staff never verify an address — the owner vouched for them by
          // typing it. Same as the Staff screen.
          emailVerifiedAt: new Date(),
        },
      })

      await tx.branch.update({ where: { id: branch.id }, data: { managerId: person.id } })

      return {
        branch,
        created: {
          userId: person.id,
          name: person.name,
          email: person.email,
          signInCode,
        },
      }
    }

    return { branch, created: null }
  })
}
