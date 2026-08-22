import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { CartCheckout } from '@/features/orders/components/cart-checkout'
import { resolvePublicBranch } from '@/features/branches/public-branch'
import { resolvePublicTenant } from '@/server/db/tenant'
import { BrandTheme } from '@/features/orders/components/brand-theme'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Your order' }

/**
 * The checkout, for one branch.
 *
 * The old cart page took no params at all and resolved no branch: the quote
 * came back at the restaurant's base prices while the menu the guest had just
 * browsed used the branch's, and a dish the branch does not sell was only
 * refused at the final tap. The branch is in the path now, so the summary and
 * the menu cannot disagree.
 */
export default async function BranchCartPage({
  params,
}: {
  params: Promise<{ slug: string; branch: string }>
}) {
  const { slug, branch: branchCode } = await params

  const restaurant = await resolvePublicTenant(slug)
  if (!restaurant) notFound()

  const branch = await resolvePublicBranch(restaurant.id, branchCode).catch(() => null)
  if (!branch) notFound()

  return (
    <BrandTheme logoUrl={restaurant.logoUrl} coverUrl={restaurant.coverUrl}>
      <CartCheckout
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
        taxLabel={restaurant.taxLabel}
        restaurantName={restaurant.name}
        loyaltyEnabled={restaurant.loyaltyEnabled}
        loyaltyEarnRateX100={restaurant.loyaltyEarnRateX100}
        slug={slug}
        branchCode={branch.code}
      />
    </BrandTheme>
  )
}
