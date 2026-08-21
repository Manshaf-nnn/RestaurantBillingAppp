import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { SupplierProfile } from '@/features/suppliers/components/supplier-profile'
import { getSupplierLedger } from '@/features/suppliers/ledger'
import { getSupplierPricing } from '@/features/purchasing/queries'
import { Badge } from '@/components/ui/badge'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Supplier' }

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

  const [pricing, ledger] = await Promise.all([
    getSupplierPricing({
      restaurantId: user.restaurantId,
      supplierId,
      currency: restaurant.currency,
    }),
    getSupplierLedger({ restaurantId: user.restaurantId, supplierId }),
  ])

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
        title={ledger.supplier.name}
        description={
          [
            ledger.supplier.company,
            ledger.supplier.contactName,
            ledger.supplier.phone,
          ]
            .filter(Boolean)
            .join(' · ') || 'Supplier'
        }
        actions={
          ledger.supplier.isActive ? null : <Badge variant="secondary">Inactive</Badge>
        }
      />
      <SupplierProfile
        ledger={ledger}
        pricing={pricing}
        currency={restaurant.currency}
        canPay={can(user, PERMISSIONS.SUPPLIER_PAYMENT)}
      />
    </>
  )
}
