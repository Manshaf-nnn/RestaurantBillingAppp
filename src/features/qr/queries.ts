import 'server-only'

import type { Prisma, QrExperience, QrExperienceField } from '@prisma/client'

import { getPublicMenu, type PublicMenu } from '@/features/menu/queries'
import { prisma } from '@/server/db/prisma'
import { readPublicId } from './public-id'

/**
 * Reading a QR experience, and the menu it shows.
 *
 * Every read here narrows an EXISTING query rather than writing a new one:
 * `experienceMenu` calls `getPublicMenu` and drops what the owner excluded, so
 * prices, happy hour, branch overrides and availability all keep coming from
 * the one place that has ever decided them (ar.md §10, §26).
 */

/** Built-in field keys, which write real `Customer` columns. */
export const BUILT_IN_KEYS = ['name', 'phone', 'email', 'birthday', 'anniversary'] as const
export type BuiltInKey = (typeof BUILT_IN_KEYS)[number]

export function isBuiltInKey(key: string): key is BuiltInKey {
  return (BUILT_IN_KEYS as readonly string[]).includes(key)
}

/** The labels and types the five built-ins get when an owner switches them on. */
export const BUILT_IN_FIELDS: Array<{
  key: BuiltInKey
  label: string
  type: 'TEXT' | 'PHONE' | 'EMAIL' | 'DATE'
}> = [
  { key: 'name', label: 'Name', type: 'TEXT' },
  { key: 'phone', label: 'Phone number', type: 'PHONE' },
  { key: 'email', label: 'Email', type: 'EMAIL' },
  { key: 'birthday', label: 'Date of birth', type: 'DATE' },
  { key: 'anniversary', label: 'Anniversary', type: 'DATE' },
]

export type ExperienceWithFields = QrExperience & { fields: QrExperienceField[] }

/** One experience with everything the public screens need, by its printed code. */
export async function resolveExperience(code: string | null | undefined): Promise<
  | (ExperienceWithFields & {
      restaurant: { id: string; name: string; slug: string; timezone: string; currency: string; locale: string; logoUrl: string | null; taxLabel: string | null; loyaltyEnabled: boolean; loyaltyEarnRateX100: number }
      branch: { id: string; name: string; code: string }
    })
  | null
> {
  const publicId = readPublicId(code)
  if (!publicId) return null

  return prisma.qrExperience.findUnique({
    where: { publicId },
    include: {
      fields: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      restaurant: {
        select: {
          id: true, name: true, slug: true, timezone: true, currency: true, locale: true,
          logoUrl: true, taxLabel: true, loyaltyEnabled: true, loyaltyEarnRateX100: true,
        },
      },
      branch: { select: { id: true, name: true, code: true } },
    },
  })
}

/** One experience for the owner's screens. Tenant-scoped — never by id alone. */
export async function getExperience(params: {
  restaurantId: string
  experienceId: string
}): Promise<(ExperienceWithFields & { branch: { id: string; name: string; code: string } }) | null> {
  return prisma.qrExperience.findFirst({
    where: { id: params.experienceId, restaurantId: params.restaurantId },
    include: {
      fields: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      branch: { select: { id: true, name: true, code: true } },
    },
  })
}

export interface ExperienceRow {
  id: string
  publicId: string
  name: string
  description: string | null
  type: string
  isActive: boolean
  branchId: string
  branchName: string
  openCount: number
  lastOpenedAt: string | null
  createdAt: string
  /** Real joins, not a counter — §22 wants orders and sales, not impressions. */
  orderCount: number
  salesTotal: number
}

/**
 * The list (ar.md §18).
 *
 * `branchIds` null means every branch this person can see; `[]` means none,
 * which is a real answer for somebody confined to a branch that has none.
 */
export async function listExperiences(params: {
  restaurantId: string
  branchIds: string[] | null
}): Promise<ExperienceRow[]> {
  const where: Prisma.QrExperienceWhereInput = {
    restaurantId: params.restaurantId,
    ...(params.branchIds === null ? {} : { branchId: { in: params.branchIds } }),
  }

  const rows = await prisma.qrExperience.findMany({
    where,
    include: { branch: { select: { name: true } } },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  })
  if (rows.length === 0) return []

  /*
   * Orders and sales in one grouped pass rather than a count per row: a
   * restaurant with twenty codes should not cost forty queries to list.
   * Cancelled orders are excluded — an abandoned basket is not a sale.
   */
  const totals = await prisma.order.groupBy({
    by: ['qrExperienceId'],
    where: {
      restaurantId: params.restaurantId,
      qrExperienceId: { in: rows.map((row) => row.id) },
      status: { not: 'CANCELLED' },
    },
    _count: { _all: true },
    _sum: { grandTotal: true },
  })
  const byId = new Map(totals.map((row) => [row.qrExperienceId, row]))

  return rows.map((row) => ({
    id: row.id,
    publicId: row.publicId,
    name: row.name,
    description: row.description,
    type: row.type,
    isActive: row.isActive,
    branchId: row.branchId,
    branchName: row.branch.name,
    openCount: row.openCount,
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    orderCount: byId.get(row.id)?._count._all ?? 0,
    salesTotal: byId.get(row.id)?._sum.grandTotal ?? 0,
  }))
}

/**
 * The menu this code shows (ar.md §10).
 *
 * `getPublicMenu` decides everything about the items — branch prices, happy
 * hour, availability, option groups. This only removes what the owner said to
 * leave out, then drops any category left with nothing in it, exactly as
 * `getPublicMenu` does for the unfiltered list.
 *
 * A CUSTOM menu with nothing chosen shows nothing. That is the honest reading:
 * the owner said "choose", and choosing none is a configuration mistake they
 * can see on the preview rather than one that silently shows everything.
 */
export async function experienceMenu(experience: {
  restaurantId: string
  branchId: string
  menuMode: string
  menuCategoryIds: Prisma.JsonValue | null
  menuFoodIds: Prisma.JsonValue | null
}, timeZone: string): Promise<PublicMenu> {
  const menu = await getPublicMenu(experience.restaurantId, timeZone, experience.branchId)
  if (experience.menuMode !== 'CUSTOM') return menu

  const categoryIds = new Set(readIdList(experience.menuCategoryIds))
  const foodIds = new Set(readIdList(experience.menuFoodIds))

  const items = menu.items.filter(
    (item) => foodIds.has(item.id) || (item.categoryId !== null && categoryIds.has(item.categoryId)),
  )
  const kept = new Set(items.map((item) => item.categoryId))
  return {
    items,
    categories: menu.categories
      .filter((category) => kept.has(category.id))
      .map((category) => ({
        ...category,
        itemCount: items.filter((item) => item.categoryId === category.id).length,
      })),
  }
}

/** A Json id-list column, defensively. */
export function readIdList(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Which fields a guest is shown (ar.md §5, §7).
 *
 * Everything with no category, plus the extras for the category they picked —
 * and nothing belonging to a category they did not pick, which is §7's "Do NOT
 * show irrelevant fields". HIDDEN rows never reach a screen at all.
 *
 * A category-specific row overrides the general one with the same key, so an
 * owner can say "phone optional generally, required for VIP" and get one box.
 */
export function fieldsFor(
  fields: QrExperienceField[],
  categoryId: string | null,
): QrExperienceField[] {
  const visible = fields.filter((field) => field.rule !== 'HIDDEN')
  const general = visible.filter((field) => field.categoryId === null)
  const specific = categoryId ? visible.filter((field) => field.categoryId === categoryId) : []

  const overridden = new Set(specific.map((field) => field.key))
  return [...general.filter((field) => !overridden.has(field.key)), ...specific].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key),
  )
}

/** The customer categories this code offers, from the CRM's own list (ar.md §6). */
export async function categoriesFor(experience: {
  restaurantId: string
  customerCategoryIds: Prisma.JsonValue | null
}): Promise<Array<{ id: string; name: string; colour: string | null }>> {
  const chosen = readIdList(experience.customerCategoryIds)
  return prisma.customerCategory.findMany({
    where: {
      restaurantId: experience.restaurantId,
      isActive: true,
      ...(chosen.length > 0 ? { id: { in: chosen } } : {}),
    },
    select: { id: true, name: true, colour: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
}

export interface ExperienceStats {
  openCount: number
  lastOpenedAt: string | null
  orders: number
  sales: number
  customers: number
  newCustomers: number
  byCategory: Array<{ name: string; customers: number }>
  topItems: Array<{ name: string; quantity: number }>
}

/**
 * What this code has actually done (ar.md §22).
 *
 * Every figure but the open count is a real join on `Order.qrExperienceId` or
 * `Customer.sourceQrExperienceId` — the same order and customer tables the
 * rest of reporting reads. There is no separate analytics store.
 */
export async function experienceStats(params: {
  restaurantId: string
  experienceId: string
}): Promise<ExperienceStats> {
  const orderWhere: Prisma.OrderWhereInput = {
    restaurantId: params.restaurantId,
    qrExperienceId: params.experienceId,
    status: { not: 'CANCELLED' },
  }

  const [row, totals, distinct, newCustomers, categories, items] = await Promise.all([
    prisma.qrExperience.findFirst({
      where: { id: params.experienceId, restaurantId: params.restaurantId },
      select: { openCount: true, lastOpenedAt: true },
    }),
    prisma.order.aggregate({ where: orderWhere, _count: { _all: true }, _sum: { grandTotal: true } }),
    prisma.order.findMany({
      where: { ...orderWhere, customerId: { not: null } },
      select: { customerId: true },
      distinct: ['customerId'],
    }),
    prisma.customer.count({
      where: { restaurantId: params.restaurantId, sourceQrExperienceId: params.experienceId },
    }),
    prisma.customer.groupBy({
      by: ['categoryId'],
      where: { restaurantId: params.restaurantId, sourceQrExperienceId: params.experienceId },
      _count: { _all: true },
    }),
    prisma.orderItem.groupBy({
      by: ['name'],
      where: { order: orderWhere, status: { not: 'CANCELLED' } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    }),
  ])

  const named = categories.filter((entry) => entry.categoryId !== null)
  const categoryNames = named.length
    ? await prisma.customerCategory.findMany({
        where: { id: { in: named.map((entry) => entry.categoryId!) } },
        select: { id: true, name: true },
      })
    : []
  const nameById = new Map(categoryNames.map((entry) => [entry.id, entry.name]))

  return {
    openCount: row?.openCount ?? 0,
    lastOpenedAt: row?.lastOpenedAt?.toISOString() ?? null,
    orders: totals._count._all,
    sales: totals._sum.grandTotal ?? 0,
    customers: distinct.length,
    newCustomers,
    byCategory: named
      .map((entry) => ({ name: nameById.get(entry.categoryId!) ?? 'Unknown', customers: entry._count._all }))
      .sort((a, b) => b.customers - a.customers),
    topItems: items.map((entry) => ({ name: entry.name, quantity: entry._sum.quantity ?? 0 })),
  }
}
