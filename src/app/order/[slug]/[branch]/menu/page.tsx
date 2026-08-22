import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { getPublicMenu } from '@/features/menu/queries'
import { orderableBranches, resolvePublicBranch } from '@/features/branches/public-branch'
import { BrandTheme } from '@/features/orders/components/brand-theme'
import { MenuBrowser } from '@/features/orders/components/menu-browser'
import { resolvePublicTenant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const restaurant = await resolvePublicTenant(slug)
  return { title: restaurant ? `${restaurant.name} — Menu` : 'Menu' }
}

/**
 * One branch's menu, at that branch's prices.
 *
 * This is the screen the old design lost the branch on: `CoverPage` pushed a
 * bare `/order/menu`, so the branch fell back to the cookie and, when that was
 * missing or stale, to the default branch. A guest correctly seated at Branch
 * 02 then browsed Main's menu at Main's prices. The branch is in the path now.
 */
export default async function BranchMenuPage({
  params,
}: {
  params: Promise<{ slug: string; branch: string }>
}) {
  const { slug, branch: branchCode } = await params

  const restaurant = await resolvePublicTenant(slug)
  if (!restaurant) notFound()

  const branch = await resolvePublicBranch(restaurant.id, branchCode).catch(() => null)
  if (!branch) notFound()

  const [menu, orderable] = await Promise.all([
    getPublicMenu(restaurant.id, restaurant.timezone, branch.id),
    orderableBranches(restaurant.id),
  ])

  return (
    <BrandTheme logoUrl={restaurant.logoUrl} coverUrl={restaurant.coverUrl}>
      <MenuBrowser
        menu={menu}
        restaurantName={restaurant.name}
        logoUrl={restaurant.logoUrl}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
        taxLabel={restaurant.taxLabel}
        slug={slug}
        branchCode={branch.code}
        // Named on the menu too — it never was, so a guest browsing the wrong
        // branch's prices had nothing on screen to tell them.
        branchName={orderable.length > 1 ? branch.name : null}
      />
    </BrandTheme>
  )
}
