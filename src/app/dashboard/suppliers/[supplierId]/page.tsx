import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { SupplierPricing } from '@/features/purchasing/components/supplier-pricing'
import { getSupplierPricing } from '@/features/purchasing/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Supplier pricing' }

export default async function SupplierPricingPage({
  params,
}: {
  params: Promise<{ supplierId: string }>
}) {
  const { supplierId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SUPPLIER_VIEW,
    `/dashboard/suppliers/${supplierId}`,
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const data = await getSupplierPricing({
    restaurantId: user.restaurantId,
    supplierId,
    currency: restaurant.currency,
  })

  return (
    <>
      <Link
        href="/dashboard/suppliers"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Suppliers
      </Link>
      <PageHeader
        title={data.supplier.name}
        description="What this supplier charges, and how their packaging converts into your stock units."
      />
      <SupplierPricing data={data} />
    </>
  )
}
