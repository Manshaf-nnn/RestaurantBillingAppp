import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { orderableBranches, resolvePublicBranch } from '@/features/branches/public-branch'
import { BrandTheme } from '@/features/orders/components/brand-theme'
import { MenuBrowser } from '@/features/orders/components/menu-browser'
import { getOrderForGuest } from '@/features/orders/queries'
import { narrowAppearance } from '@/features/guest/appearance'
import { getGuestAppearance } from '@/features/guest/queries'
import { askedForPreview, qrAccess } from '@/features/qr/access'
import { qrPath } from '@/features/qr/guest-path'
import { experienceMenu, resolveExperience } from '@/features/qr/queries'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>
}): Promise<Metadata> {
  const { code } = await params
  const experience = await resolveExperience(code)
  return { title: experience ? `${experience.restaurant.name} — Menu` : 'Menu' }
}

/**
 * The menu this code shows (ar.md §10, §13).
 *
 * The same `MenuBrowser` the ordinary QR flow renders, over the same
 * `getPublicMenu` — narrowed to what the owner chose, and told whether it may
 * take an order. There is no second menu, no second catalogue and no second
 * set of prices; branch pricing, happy hour and availability all still come
 * from the one place that has ever decided them.
 */
export default async function QrMenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ code }, query] = await Promise.all([params, searchParams])

  const experience = await resolveExperience(code)
  if (!experience) notFound()

  const access = await qrAccess({ experience, asked: askedForPreview(query.preview) })
  if (!access.allowed) notFound()

  const branch = await resolvePublicBranch(experience.restaurantId, experience.branch.code).catch(
    () => null,
  )
  if (!branch) notFound()

  const ordering = experience.type === 'ORDERING'

  /*
   * "Add to this order" mode, only where ordering exists at all. The guest's
   * own open, unpaid order or nothing — the session cookie is the
   * authorisation, so a pasted id for somebody else's order resolves to
   * nothing and this opens as a plain menu.
   */
  const addTo =
    ordering && typeof query.add === 'string'
      ? await getOrderForGuest(experience.restaurantId, query.add)
      : null
  const addingTo =
    addTo && !['SERVED', 'COMPLETED', 'CANCELLED'].includes(addTo.status) && addTo.paymentStatus === 'UNPAID'
      ? { orderId: addTo.id, orderNumber: addTo.orderNumber }
      : null

  const [menu, orderable, restaurantAppearance] = await Promise.all([
    experienceMenu(experience, experience.restaurant.timezone),
    orderableBranches(experience.restaurantId),
    getGuestAppearance(experience.restaurantId),
  ])
  // The restaurant's setting, narrowed by this code's own switches.
  const appearance = narrowAppearance(restaurantAppearance, experience)

  return (
    <BrandTheme logoUrl={experience.restaurant.logoUrl} coverUrl={null}>
      <MenuBrowser
        menu={menu}
        restaurantName={experience.restaurant.name}
        logoUrl={experience.restaurant.logoUrl}
        currency={experience.restaurant.currency}
        locale={
          experience.restaurant.locale === 'en'
            ? localeForCurrency(experience.restaurant.currency)
            : experience.restaurant.locale
        }
        taxLabel={experience.restaurant.taxLabel}
        slug={experience.restaurant.slug}
        basePath={qrPath(experience.publicId)}
        /*
         * A menu-only code cannot reach the basket at all — no cart bar, no
         * Add button, and no redirect demanding a table. That is §3B's "must
         * NOT automatically create an order", enforced by removing the paths
         * rather than by hoping nobody finds one.
         */
        ordering={ordering}
        /*
         * A code with no table never seated anybody, so the menu must not
         * send them back to pick one (ar.md §3).
         */
        requiresTable={experience.askTable}
        showSearch={appearance.menuShowSearch}
        showPrices={appearance.menuShowPrices}
        showImages={appearance.menuShowImages}
        showDescriptions={appearance.menuShowDescriptions}
        showFeatured={appearance.menuShowFeatured}
        addingTo={addingTo}
        branchName={orderable.length > 1 ? branch.name : null}
      />
    </BrandTheme>
  )
}
