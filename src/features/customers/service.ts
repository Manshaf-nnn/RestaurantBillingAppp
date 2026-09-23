import 'server-only'

import type { Customer, Prisma } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { normalisePhone, phoneKey } from './phone'

/**
 * The customer record, and the one place that decides whether two numbers are
 * the same person (pro.A.md §1, §20).
 *
 * Every door — the CRM, the till, a QR order, the website — goes through here,
 * so a guest who orders at the counter on Monday and scans a QR code on Friday
 * is one customer with one loyalty balance.
 */

export interface CustomerInput {
  name?: string | null
  phone: string
  email?: string | null
  notes?: string | null
  address?: string | null
  categoryId?: string | null
  birthday?: Date | null
  anniversary?: Date | null
}

export interface CustomerMatch {
  customer: Customer
  /** False when the record already existed and was returned rather than made. */
  created: boolean
}

async function requireCategory(restaurantId: string, categoryId: string) {
  const category = await prisma.customerCategory.findFirst({
    where: { id: categoryId, restaurantId },
    select: { id: true, isActive: true, name: true },
  })
  if (!category) throw new NotFoundError('Customer category')
  if (!category.isActive) {
    throw new AppError(`The ${category.name} category is no longer in use`, 409, 'CATEGORY_INACTIVE')
  }
  return category
}

/**
 * Who this number belongs to, if anybody.
 *
 * Matches on the normalised key first — that is the whole point — and falls
 * back to the raw string so a record written before the key existed, or one
 * whose key was left null by a collision the migration declined to merge, is
 * still found.
 */
export async function findCustomerByPhone(params: {
  restaurantId: string
  phone: string
}): Promise<Customer | null> {
  const key = phoneKey(params.phone)
  if (!key) return null

  const byKey = await prisma.customer.findFirst({
    where: { restaurantId: params.restaurantId, phoneKey: key },
  })
  if (byKey) return byKey

  return prisma.customer.findFirst({
    where: { restaurantId: params.restaurantId, phone: normalisePhone(params.phone) },
  })
}

/**
 * Find this person, or make them.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * Overwrite a name. The order path used to upsert with whatever the cashier
 * typed, so a hurried "Jon" permanently renamed "Jonathan Perera" — and the
 * next cashier, seeing "Jon", had no idea anything had been lost. A name is
 * only written when the record has none, or when somebody edits the customer
 * deliberately through the CRM.
 */
export async function findOrCreateCustomer(params: {
  restaurantId: string
  input: CustomerInput
  /** A blank phone means no record at all — never a shared anonymous account. */
  allowBlank?: boolean
}): Promise<CustomerMatch | null> {
  const phone = normalisePhone(params.input.phone)
  const key = phoneKey(phone)
  if (!key) {
    if (params.allowBlank) return null
    throw new AppError('A phone number is needed', 400, 'CUSTOMER_NO_PHONE')
  }

  if (params.input.categoryId) await requireCategory(params.restaurantId, params.input.categoryId)

  const existing = await findCustomerByPhone({ restaurantId: params.restaurantId, phone })
  if (existing) {
    /*
     * Fill in the blanks and nothing else. Somebody giving their email at the
     * till should not have to give it again next time; somebody mistyping a
     * name should not be able to rename a regular.
     */
    const fill: Prisma.CustomerUpdateInput = {}
    if (!existing.phoneKey) fill.phoneKey = key
    if (!existing.name?.trim() && params.input.name?.trim()) fill.name = params.input.name.trim()
    if (!existing.email && params.input.email) fill.email = params.input.email
    if (!existing.address && params.input.address) fill.address = params.input.address

    const customer = Object.keys(fill).length
      ? await prisma.customer.update({ where: { id: existing.id }, data: fill })
      : existing
    return { customer, created: false }
  }

  try {
    const customer = await prisma.customer.create({
      data: {
        restaurantId: params.restaurantId,
        name: params.input.name?.trim() || 'Guest',
        phone,
        phoneKey: key,
        email: params.input.email || null,
        notes: params.input.notes || null,
        address: params.input.address || null,
        categoryId: params.input.categoryId || null,
        birthday: params.input.birthday ?? null,
        anniversary: params.input.anniversary ?? null,
      },
    })
    return { customer, created: true }
  } catch (error) {
    /*
     * Two tills ringing up the same new guest at the same moment. The unique
     * key refused the second one, which is correct — read the winner and use
     * it, because "there is already a customer with that number" is not
     * something the cashier did wrong.
     */
    if ((error as { code?: string }).code === 'P2002') {
      const winner = await findCustomerByPhone({ restaurantId: params.restaurantId, phone })
      if (winner) return { customer: winner, created: false }
    }
    throw error
  }
}

/** Edit a customer deliberately, from the CRM. Names may change here. */
export async function updateCustomer(params: {
  restaurantId: string
  customerId: string
  input: CustomerInput & { isBlocked?: boolean }
}): Promise<Customer> {
  const existing = await prisma.customer.findFirst({
    where: { id: params.customerId, restaurantId: params.restaurantId },
  })
  if (!existing) throw new NotFoundError('Customer')

  if (params.input.categoryId) await requireCategory(params.restaurantId, params.input.categoryId)

  const phone = normalisePhone(params.input.phone)
  const key = phoneKey(phone)
  if (!key) throw new AppError('A phone number is needed', 400, 'CUSTOMER_NO_PHONE')

  // Changing a number onto somebody else's is a merge, and a merge is a
  // decision, not a side effect of an edit.
  const clash = await prisma.customer.findFirst({
    where: { restaurantId: params.restaurantId, phoneKey: key, id: { not: existing.id } },
    select: { id: true, name: true },
  })
  if (clash) {
    throw new AppError(
      `${clash.name} already has that number. Open their record instead.`,
      409,
      'CUSTOMER_PHONE_TAKEN',
    )
  }

  return prisma.customer.update({
    where: { id: existing.id },
    data: {
      name: params.input.name?.trim() || existing.name,
      phone,
      phoneKey: key,
      email: params.input.email || null,
      notes: params.input.notes || null,
      address: params.input.address || null,
      categoryId: params.input.categoryId || null,
      birthday: params.input.birthday ?? null,
      anniversary: params.input.anniversary ?? null,
      ...(params.input.isBlocked === undefined ? {} : { isBlocked: params.input.isBlocked }),
    },
  })
}

/* ── categories (pro.A.md §1) ─────────────────────────────────────────────── */

export async function listCustomerCategories(params: {
  restaurantId: string
  includeInactive?: boolean
}) {
  return prisma.customerCategory.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { customers: true } } },
  })
}

export async function saveCustomerCategory(params: {
  restaurantId: string
  id?: string | null
  name: string
  colour?: string | null
  sortOrder?: number
}) {
  const name = params.name.trim()
  if (name.length < 2) throw new AppError('Give the category a name', 400, 'CATEGORY_NO_NAME')

  try {
    if (params.id) {
      const existing = await prisma.customerCategory.findFirst({
        where: { id: params.id, restaurantId: params.restaurantId },
      })
      if (!existing) throw new NotFoundError('Customer category')
      return await prisma.customerCategory.update({
        where: { id: existing.id },
        data: { name, colour: params.colour || null, ...(params.sortOrder === undefined ? {} : { sortOrder: params.sortOrder }) },
      })
    }
    return await prisma.customerCategory.create({
      data: {
        restaurantId: params.restaurantId,
        name,
        colour: params.colour || null,
        sortOrder: params.sortOrder ?? 0,
      },
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new AppError(`There is already a “${name}” category`, 409, 'CATEGORY_EXISTS')
    }
    throw error
  }
}

/**
 * Retire a category, or delete one nothing depends on.
 *
 * A category that customers point at is never deleted — their history says
 * they were a Student, and a delete would rewrite that into nothing. It is
 * switched off instead, so nobody new can be put in it and everybody already
 * in it keeps their label.
 */
export async function removeCustomerCategory(params: { restaurantId: string; id: string }) {
  const category = await prisma.customerCategory.findFirst({
    where: { id: params.id, restaurantId: params.restaurantId },
    include: { _count: { select: { customers: true } } },
  })
  if (!category) throw new NotFoundError('Customer category')

  if (category._count.customers > 0) {
    const retired = await prisma.customerCategory.update({
      where: { id: category.id },
      data: { isActive: false },
    })
    return { deleted: false, category: retired, customers: category._count.customers }
  }

  await prisma.customerCategory.delete({ where: { id: category.id } })
  return { deleted: true, category, customers: 0 }
}

export async function setCustomerCategoryActive(params: {
  restaurantId: string
  id: string
  isActive: boolean
}) {
  const category = await prisma.customerCategory.findFirst({
    where: { id: params.id, restaurantId: params.restaurantId },
  })
  if (!category) throw new NotFoundError('Customer category')
  return prisma.customerCategory.update({
    where: { id: category.id },
    data: { isActive: params.isActive },
  })
}
