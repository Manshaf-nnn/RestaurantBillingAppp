import type { Metadata } from 'next'

import { CustomersManager } from '@/features/staff/components/customers-manager'
import { can, PERMISSIONS } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { prisma } from '@/server/db/prisma'
import { listCustomerCategories } from '@/features/customers/service'
import { listSegment, type CustomerSegment } from '@/features/customers/segments'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Customers' }

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.CUSTOMER_VIEW, '/dashboard/customers')

  /*
   * `selectedBranch`, not `visibleBranchIds` alone.
   *
   * This read the RBAC reach directly, so for an owner it was always `null` and
   * the branch switcher had no effect on this page whatsoever — pick Kandy and
   * the customer list did not move. `selectedBranch` folds the chosen branch
   * into the same reach every other screen uses, and cannot widen it: an
   * out-of-reach id degrades to the reach rather than overriding it.
   */
  const selection = await selectedBranch(user, await searchParams)

  /*
   * The filter lives in the URL and the narrowing happens in the DATABASE
   * (pro.A.md §3, §26). It used to load five hundred rows and filter them in
   * the browser, which is wrong twice: it cannot find the five-hundred-and-
   * first customer, and it ships every guest's phone number to the client to
   * hide most of them again.
   */
  const params = await searchParams
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '')
  const num = (key: string) => {
    const raw = one(key)
    if (!raw) return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? Math.trunc(value) : undefined
  }
  const segment: CustomerSegment = {
    ...(one('q') ? { q: one('q') } : {}),
    ...(one('category') ? { categoryId: one('category') } : {}),
    ...(num('minVisits') !== undefined ? { minVisits: num('minVisits') } : {}),
    ...(num('minSpent') !== undefined ? { minSpent: num('minSpent')! * 100 } : {}),
    ...(num('notSeenForDays') !== undefined ? { notSeenForDays: num('notSeenForDays') } : {}),
    ...(num('minPoints') !== undefined ? { minPoints: num('minPoints') } : {}),
    ...(['new', 'returning', 'repeat', 'regular', 'lapsed'].includes(one('kind'))
      ? { kind: one('kind') as CustomerSegment['kind'] }
      : {}),
  }
  const page = Math.max(1, num('page') ?? 1)

  const [restaurant, listed, categories] = await Promise.all([
    requireRestaurant(user.restaurantId),
    // Each branch sees the people who have ordered there. See
    // `customersAtBranch` for why the RECORD stays whole.
    listSegment({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      segment,
      page,
      perPage: 50,
    }),
    // The owner's own categories (pro.A.md §1), including retired ones so the
    // manager can revive them.
    listCustomerCategories({ restaurantId: user.restaurantId, includeInactive: true }),
  ])
  const customers = listed.rows

  /*
   * What each of these people still owes.
   *
   * Their own unpaid bills — grandTotal less paidTotal on anything not
   * settled and not cancelled. One grouped query for the page rather than one
   * per row, because this list renders fifty at a time.
   *
   * Deliberately NOT `Customer.totalSpent`, which is lifetime takings and
   * therefore the opposite question. A customer can have spent a fortune and
   * owe nothing, and the column an owner chases is the second one.
   */
  const owing = customers.length
    ? await prisma.order.groupBy({
        by: ['customerId'],
        where: {
          restaurantId: user.restaurantId,
          customerId: { in: customers.map((customer) => customer.id) },
          status: { not: 'CANCELLED' },
          paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
        },
        _sum: { grandTotal: true, paidTotal: true },
      })
    : []
  const dueByCustomer = new Map(
    owing.map((row) => [
      row.customerId,
      Math.max(0, (row._sum.grandTotal ?? 0) - (row._sum.paidTotal ?? 0)),
    ]),
  )

  return (
    <CustomersManager
      canManage={can(user, PERMISSIONS.CUSTOMER_MANAGE)}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
      customers={customers.map((customer) => ({
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        notes: customer.notes,
        loyaltyPoints: customer.loyaltyPoints,
        totalSpent: customer.totalSpent,
        due: dueByCustomer.get(customer.id) ?? 0,
        totalOrders: customer.totalOrders,
        lastOrderAt: customer.lastOrderAt?.toISOString() ?? null,
        isBlocked: customer.isBlocked,
        address: customer.address,
        categoryId: customer.categoryId,
        categoryName: customer.category?.name ?? null,
        birthday: customer.birthday?.toISOString() ?? null,
        anniversary: customer.anniversary?.toISOString() ?? null,
      }))}
      categories={categories.filter((category) => category.isActive).map((category) => ({ id: category.id, name: category.name }))}
      total={listed.total}
      page={listed.page}
      pages={listed.pages}
      canDiscountGroup={can(user, PERMISSIONS.DISCOUNT_APPLY) && can(user, PERMISSIONS.CUSTOMER_MANAGE)}
      categoryRows={categories.map((category) => ({
        id: category.id,
        name: category.name,
        colour: category.colour,
        isActive: category.isActive,
        customers: category._count.customers,
      }))}
    />
  )
}
