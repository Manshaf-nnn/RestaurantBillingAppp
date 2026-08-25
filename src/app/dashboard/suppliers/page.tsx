import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronRight, Star } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { SuppliersManager } from '@/features/inventory/components/suppliers-manager'
import { listSuppliersWithCounts } from '@/features/purchasing/queries'
import { getSupplierBalances } from '@/features/suppliers/ledger'
import { SearchBox } from '@/components/search-box'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { visibleBranchIds, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Suppliers' }

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.SUPPLIER_VIEW, '/dashboard/suppliers')
  const params = await searchParams
  const search = (typeof params.search === 'string' ? params.search : '').trim()

  const [suppliers, withCounts, balances, restaurant] = await Promise.all([
    prisma.supplier.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { items: true } } },
    }),
    listSuppliersWithCounts(user.restaurantId),
    // One set of grouped queries for the whole page rather than a ledger read
    // per row.
    // Same reach as the ledger behind each row, so the list total and the
    // statement it opens cannot disagree.
    getSupplierBalances(user.restaurantId, visibleBranchIds(user)),
    requireRestaurant(user.restaurantId),
  ])

  const money = (m: number) => formatMoney(m, restaurant.currency)

  /*
   * Filtered here rather than in the query: this list is every supplier a
   * restaurant has, which is tens, not thousands. A round trip per keystroke
   * would cost more than the filter saves.
   */
  const term = search.toLowerCase()
  const matches = (s: { name: string; company: string | null; contactName?: string | null; phone?: string | null }) =>
    !term ||
    [s.name, s.company, s.contactName, s.phone].some((field) =>
      field?.toLowerCase().includes(term),
    )

  const active = withCounts.filter((s) => s.isActive && matches(s))
  const owed = [...balances.values()].reduce((sum, value) => sum + Math.max(0, value), 0)

  return (
    <>
      <PageHeader
        title="Suppliers"
        description={
          owed > 0
            ? `${money(owed)} outstanding across ${[...balances.values()].filter((v) => v > 0).length} supplier(s).`
            : 'Who you buy from, what they charge, and what you owe them.'
        }
      />

      <div className="mb-4 max-w-sm">
        <SearchBox placeholder="Supplier, company, contact or phone…" defaultValue={search} />
      </div>

      {search && active.length === 0 ? (
        <div className="mb-6">
          <EmptyState
            title={`Nothing matches “${search}”`}
            description="Try the supplier's name, their company, a contact name or a phone number."
          />
        </div>
      ) : null}

      {active.length > 0 && (
        <div className="mb-6">
          <SectionCard
            title="Price lists"
            description="What each supplier charges. These prices fill in the purchase order form and drive the reorder suggestions."
          >
            <ul className="divide-y divide-border">
              {active.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/dashboard/suppliers/${s.id}`}
                    className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-3 hover:bg-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.company ? `${s.company} · ` : ''}
                        {s.paymentTerms.replace('_', ' ').toLowerCase()}
                        {s.orderCount > 0 ? ` · ${s.orderCount} order${s.orderCount === 1 ? '' : 's'}` : ''}
                      </p>
                    </div>
                    {/*
                      What is owed, on the list itself. Previously the only
                      figure here was a count of price rows, which is not a
                      question anyone asks about a supplier.
                    */}
                    {(balances.get(s.id) ?? 0) > 0 ? (
                      <Badge variant="warning">{money(balances.get(s.id) ?? 0)} owed</Badge>
                    ) : (balances.get(s.id) ?? 0) < 0 ? (
                      <Badge variant="secondary">{money(-(balances.get(s.id) ?? 0))} in credit</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">settled</span>
                    )}
                    {s.itemCount > 0 ? (
                      <Badge variant="secondary">
                        <Star className="mr-1 h-3 w-3" />
                        {s.itemCount} priced
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">no prices yet</span>
                    )}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      )}

      <SuppliersManager
        suppliers={suppliers.map((supplier) => ({
          id: supplier.id,
          name: supplier.name,
          contactName: supplier.contactName,
          phone: supplier.phone,
          email: supplier.email,
          address: supplier.address,
          notes: supplier.notes,
          itemCount: supplier._count.items,
        }))}
      />
    </>
  )
}
