import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { PoBuilder } from '@/features/purchasing/components/po-builder'
import { getPoBuilderData } from '@/features/purchasing/queries'
import { getReorderSuggestions } from '@/features/purchasing/suggestions'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'New purchase order' }

export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PURCHASE_CREATE, '/dashboard/purchases/new')
  const restaurant = await requireRestaurant(user.restaurantId)
  const data = await getPoBuilderData({ restaurantId: user.restaurantId, currency: restaurant.currency })

  // "Order what's low" arrives here with ?from=low and the suggestions are
  // resolved server-side, so the quantities cannot be tampered with in the URL.
  const params = await searchParams
  const prefill =
    params.from === 'low'
      ? (await getReorderSuggestions({ restaurantId: user.restaurantId })).map((s) => ({
          itemId: s.itemId,
          quantity: s.suggestedQty,
        }))
      : undefined

  return (
    <>
      <Link
        href="/dashboard/purchases"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Purchasing
      </Link>
      <PageHeader
        title="New purchase order"
        description="What you are asking a supplier to deliver. Nothing enters stock until it arrives."
      />
      <PoBuilder data={data} prefill={prefill} />
    </>
  )
}
