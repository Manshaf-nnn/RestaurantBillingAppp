import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { getPublicMenu } from '@/features/menu/queries'
import { getOrderForGuest } from '@/features/orders/queries'
import { orderableBranches, resolvePublicBranch } from '@/features/branches/public-branch'
import { BrandTheme } from '@/features/orders/components/brand-theme'
import { MenuBrowser } from '@/features/orders/components/menu-browser'
import { getGuestAppearance } from '@/features/guest/queries'
import { guestPath } from '@/features/orders/guest-path'
import { resolvePublicTenant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

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
  searchParams,
}: {
  params: Promise<{ slug: string; branch: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { slug, branch: branchCode } = await params
  const query = await searchParams

  const restaurant = await resolvePublicTenant(slug)
  if (!restaurant) notFound()

  const branch = await resolvePublicBranch(restaurant.id, branchCode).catch(() => null)
  if (!branch) notFound()

  /*
   * `?add=<orderId>` — "add to order" mode (aO.md §3): the guest's own open,
   * unpaid order, or nothing. The cookie is the authorization, so a pasted
   * id for somebody else's order resolves to nothing and the menu opens as
   * a plain menu.
   */
  const addTo = typeof query.add === 'string' ? await getOrderForGuest(restaurant.id, query.add) : null
  const addingTo =
    addTo && !['SERVED', 'COMPLETED', 'CANCELLED'].includes(addTo.status) && addTo.paymentStatus === 'UNPAID'
      ? { orderId: addTo.id, orderNumber: addTo.orderNumber }
      : null

  const [menu, orderable, appearance] = await Promise.all([
    getPublicMenu(restaurant.id, restaurant.timezone, branch.id),
    orderableBranches(restaurant.id),
    // The same setting the QR menus read (ar.md §13).
    getGuestAppearance(restaurant.id),
  ])

  return (
    <BrandTheme logoUrl={restaurant.logoUrl} coverUrl={restaurant.coverUrl}>
      <MenuBrowser
        menu={menu}
        restaurantName={restaurant.name}
        logoUrl={restaurant.logoUrl}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        taxLabel={restaurant.taxLabel}
        slug={slug}
        basePath={guestPath(slug, branch.code)}
        showSearch={appearance.menuShowSearch}
        showPrices={appearance.menuShowPrices}
        showImages={appearance.menuShowImages}
        showDescriptions={appearance.menuShowDescriptions}
        showFeatured={appearance.menuShowFeatured}
        showDietFilter={appearance.menuShowDietFilter}
        showCallStaff={appearance.menuShowCallStaff}
        addingTo={addingTo}
        // Named on the menu too — it never was, so a guest browsing the wrong
        // branch's prices had nothing on screen to tell them.
        branchName={orderable.length > 1 ? branch.name : null}
      />
    </BrandTheme>
  )
}
