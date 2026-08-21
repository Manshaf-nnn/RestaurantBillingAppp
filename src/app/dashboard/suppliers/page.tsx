import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronRight, Star } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { SuppliersManager } from '@/features/inventory/components/suppliers-manager'
import { listSuppliersWithCounts } from '@/features/purchasing/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Suppliers' }

export default async function SuppliersPage() {
  const user = await requirePagePermission(PERMISSIONS.SUPPLIER_VIEW, '/dashboard/suppliers')

  const [suppliers, withCounts] = await Promise.all([
    prisma.supplier.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { items: true } } },
    }),
    listSuppliersWithCounts(user.restaurantId),
  ])

  const active = withCounts.filter((s) => s.isActive)

  return (
    <>
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
