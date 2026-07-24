import type { Metadata } from 'next'

import { SuppliersManager } from '@/features/inventory/components/suppliers-manager'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Suppliers' }

export default async function SuppliersPage() {
  const user = await requirePagePermission(PERMISSIONS.SUPPLIER_MANAGE, '/dashboard/suppliers')
  const suppliers = await prisma.supplier.findMany({
    where: { restaurantId: user.restaurantId, isActive: true },
    orderBy: { name: 'asc' },
    include: { _count: { select: { items: true } } },
  })

  return (
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
  )
}
