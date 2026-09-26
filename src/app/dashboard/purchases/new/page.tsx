import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PoRequestForm } from '@/features/purchasing/components/po-request-form'
import { getPoBuilderData } from '@/features/purchasing/queries'
import { getReorderSuggestions } from '@/features/purchasing/suggestions'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Purchase order request' }

export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PURCHASE_CREATE, '/dashboard/purchases/new')
  const restaurant = await requireRestaurant(user.restaurantId)
  const params = await searchParams
  const [data, selection] = await Promise.all([
    getPoBuilderData({ restaurantId: user.restaurantId, currency: restaurant.currency }),
    // The location the switcher is on is the location the request is for,
    // until the person says otherwise.
    selectedBranch(user, params),
  ])

  // "Request what's low" arrives here with ?from=low and the suggestions are
  // resolved server-side, so the quantities cannot be tampered with in the URL.
  const prefill =
    params.from === 'low'
      ? (await getReorderSuggestions({ restaurantId: user.restaurantId, branchId: selection.branchId })).map((s) => ({
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
        title="Purchase order request"
        description="Request and get approval before purchasing. Nothing enters stock until it arrives."
      />
      <PoRequestForm
        data={data}
        prefill={prefill}
        requestedBy={user.name}
        defaultBranchId={selection.branchId ?? user.branchId ?? null}
        canSubmit
      />
    </>
  )
}
