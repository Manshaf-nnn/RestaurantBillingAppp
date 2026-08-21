import 'server-only'

import { PERMISSIONS, can, visibleBranchIds, type Permission } from '@/lib/rbac'
import type { TenantUser } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

/**
 * One box that finds anything.
 *
 * There was no global search at all — not a broken one, not even a decorative
 * input. Finding a purchase order meant knowing which screen listed purchase
 * orders and then reading down it.
 *
 * Three rules govern what comes back, and the third is the one that matters:
 *
 *  1. Everything is scoped to the caller's restaurant, from the session, never
 *     from anything the client sent.
 *  2. Everything is scoped to the locations the caller may see. A branch
 *     manager searching "PO-000112" must not learn that another site ordered
 *     something.
 *  3. **You cannot find what you may not open.** Each group is gated on the
 *     same permission as the page it links to. A search that returns a row and
 *     then answers the click with /forbidden is worse than one that returns
 *     nothing — it confirms the record exists and names it, which is the whole
 *     of what the permission was hiding.
 */

export type ResultGroup =
  | 'Stock items'
  | 'Suppliers'
  | 'Purchase orders'
  | 'Deliveries'
  | 'Orders'
  | 'Customers'
  | 'Staff'

export interface SearchHit {
  id: string
  group: ResultGroup
  title: string
  subtitle: string | null
  href: string
}

/** Below this a search matches half the database and is no use to anyone. */
const MIN_TERM = 2
const PER_GROUP = 5

export async function globalSearch(params: {
  user: TenantUser
  term: string
}): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const term = params.term.trim()
  if (term.length < MIN_TERM) return { hits: [], truncated: false }

  const { user } = params
  const restaurantId = user.restaurantId
  const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })

  /*
   * `[]` means "sees nothing", not "no filter" — the distinction that has been
   * read the wrong way three separate times in this codebase, each time
   * exposing another branch's records.
   */
  const branchWhere = allowed === null ? {} : { branchId: { in: allowed } }
  const contains = { contains: term, mode: 'insensitive' as const }

  const may = (permission: Permission) => can(user, permission)

  const [items, suppliers, purchases, receipts, orders, customers, staff] = await Promise.all([
    may(PERMISSIONS.INVENTORY_VIEW)
      ? prisma.inventoryItem.findMany({
          where: {
            restaurantId,
            isActive: true,
            OR: [{ name: contains }, { sku: contains }, { barcode: contains }, { category: contains }],
          },
          select: { id: true, name: true, sku: true, category: true, unit: true, quantity: true },
          orderBy: { name: 'asc' },
          take: PER_GROUP,
        })
      : [],

    may(PERMISSIONS.SUPPLIER_VIEW)
      ? prisma.supplier.findMany({
          where: {
            restaurantId,
            OR: [
              { name: contains },
              { company: contains },
              { contactName: contains },
              { phone: contains },
              { email: contains },
            ],
          },
          select: { id: true, name: true, company: true, phone: true, isActive: true },
          orderBy: { name: 'asc' },
          take: PER_GROUP,
        })
      : [],

    may(PERMISSIONS.PURCHASE_VIEW)
      ? prisma.purchase.findMany({
          where: {
            restaurantId,
            ...branchWhere,
            OR: [
              { number: contains },
              { supplier: { name: contains } },
              { items: { some: { item: { name: contains } } } },
            ],
          },
          select: {
            id: true,
            number: true,
            status: true,
            total: true,
            supplier: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: PER_GROUP,
        })
      : [],

    may(PERMISSIONS.PURCHASE_VIEW)
      ? prisma.goodsReceipt.findMany({
          where: {
            restaurantId,
            /*
             * Two independent OR groups, so they go in an AND rather than
             * fighting over the same key: one for the search term, one for the
             * location. A receipt records where it landed and older ones fall
             * back to the order's branch, so both have to be considered.
             */
            AND: [
              { OR: [{ number: contains }, { supplierRef: contains }] },
              ...(allowed === null
                ? []
                : [
                    {
                      OR: [
                        { branchId: { in: allowed } },
                        { branchId: null, purchase: { branchId: { in: allowed } } },
                      ],
                    },
                  ]),
            ],
          },
          select: {
            id: true,
            number: true,
            supplierRef: true,
            receivedAt: true,
            purchase: { select: { id: true, number: true, supplier: { select: { name: true } } } },
          },
          orderBy: { receivedAt: 'desc' },
          take: PER_GROUP,
        })
      : [],

    may(PERMISSIONS.ORDER_VIEW)
      ? prisma.order.findMany({
          where: {
            restaurantId,
            ...branchWhere,
            OR: [{ orderNumber: contains }, { customerName: contains }, { customerPhone: contains }],
          },
          select: {
            id: true,
            orderNumber: true,
            customerName: true,
            status: true,
            grandTotal: true,
          },
          orderBy: { placedAt: 'desc' },
          take: PER_GROUP,
        })
      : [],

    may(PERMISSIONS.CUSTOMER_VIEW)
      ? prisma.customer.findMany({
          where: {
            restaurantId,
            OR: [{ name: contains }, { phone: contains }, { email: contains }],
          },
          select: { id: true, name: true, phone: true, loyaltyPoints: true },
          orderBy: { name: 'asc' },
          take: PER_GROUP,
        })
      : [],

    may(PERMISSIONS.STAFF_VIEW)
      ? prisma.user.findMany({
          where: {
            restaurantId,
            deletedAt: null,
            OR: [{ name: contains }, { email: contains }, { staffCode: contains }],
          },
          select: { id: true, name: true, role: true, staffCode: true },
          orderBy: { name: 'asc' },
          take: PER_GROUP,
        })
      : [],
  ])

  const hits: SearchHit[] = [
    ...items.map((i) => ({
      id: `item-${i.id}`,
      group: 'Stock items' as const,
      title: i.name,
      subtitle: [i.sku, i.category, `${i.quantity} ${i.unit.toLowerCase()} in stock`]
        .filter(Boolean)
        .join(' · '),
      href: `/dashboard/inventory/${i.id}`,
    })),
    ...suppliers.map((s) => ({
      id: `supplier-${s.id}`,
      group: 'Suppliers' as const,
      title: s.name,
      subtitle: [s.company, s.phone, !s.isActive && 'inactive'].filter(Boolean).join(' · ') || null,
      href: `/dashboard/suppliers/${s.id}`,
    })),
    ...purchases.map((p) => ({
      id: `purchase-${p.id}`,
      group: 'Purchase orders' as const,
      title: p.number,
      subtitle: [p.supplier?.name, p.status.replace(/_/g, ' ').toLowerCase()]
        .filter(Boolean)
        .join(' · '),
      href: `/dashboard/purchases/${p.id}`,
    })),
    ...receipts.map((r) => ({
      id: `receipt-${r.id}`,
      group: 'Deliveries' as const,
      title: r.number,
      subtitle: [r.purchase.supplier?.name, r.purchase.number, r.supplierRef && `inv ${r.supplierRef}`]
        .filter(Boolean)
        .join(' · '),
      href: `/dashboard/purchases/${r.purchase.id}/receipts/${r.id}`,
    })),
    ...orders.map((o) => ({
      id: `order-${o.id}`,
      group: 'Orders' as const,
      title: o.orderNumber,
      subtitle: [o.customerName, o.status.replace(/_/g, ' ').toLowerCase()]
        .filter(Boolean)
        .join(' · '),
      href: `/dashboard/orders/${o.id}`,
    })),
    ...customers.map((c) => ({
      id: `customer-${c.id}`,
      group: 'Customers' as const,
      title: c.name,
      subtitle: [c.phone, c.loyaltyPoints > 0 && `${c.loyaltyPoints} points`]
        .filter(Boolean)
        .join(' · '),
      href: `/dashboard/customers/${c.id}`,
    })),
    ...staff.map((u) => ({
      id: `staff-${u.id}`,
      group: 'Staff' as const,
      title: u.name,
      subtitle: [u.staffCode, u.role.replace(/_/g, ' ').toLowerCase()].filter(Boolean).join(' · '),
      href: `/dashboard/staff`,
    })),
  ]

  // Every group is capped, so a full group means there is more behind it.
  const truncated = [items, suppliers, purchases, receipts, orders, customers, staff].some(
    (group) => group.length === PER_GROUP,
  )

  return { hits, truncated }
}
