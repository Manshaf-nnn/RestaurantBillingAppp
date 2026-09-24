import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { resolvePublicBranch } from '@/features/branches/public-branch'
import { CartCheckout } from '@/features/orders/components/cart-checkout'
import { askedForPreview, qrAccess } from '@/features/qr/access'
import { narrowAppearance } from '@/features/guest/appearance'
import { getGuestAppearance } from '@/features/guest/queries'
import { qrPath } from '@/features/qr/guest-path'
import { resolveExperience } from '@/features/qr/queries'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Your order' }

/**
 * Checkout for a QR menu (ar.md §15).
 *
 * The same `CartCheckout` the ordinary flow uses, which means the order it
 * places is an ordinary TableFlow order: it reaches the cashier queue, the
 * kitchen display, the live floor, the bill and the reports exactly as any
 * other QR order does. The only thing this screen adds is the code it came
 * from, carried so the order can say where it came from afterwards.
 *
 * A menu-only code has no cart. Not a disabled one — a 404, because the route
 * does not exist for that kind of code and pretending otherwise would be a
 * path into the basket that §3B says must not be there.
 */
export default async function QrCartPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ code }, query] = await Promise.all([params, searchParams])

  const experience = await resolveExperience(code)
  if (!experience) notFound()
  if (experience.type !== 'ORDERING') notFound()

  const access = await qrAccess({ experience, asked: askedForPreview(query.preview) })
  if (!access.allowed) notFound()

  const branch = await resolvePublicBranch(experience.restaurantId, experience.branch.code).catch(
    () => null,
  )
  if (!branch) notFound()

  const appearance = narrowAppearance(await getGuestAppearance(experience.restaurantId), experience)

  return (
    <CartCheckout
      currency={experience.restaurant.currency}
      locale={
        experience.restaurant.locale === 'en'
          ? localeForCurrency(experience.restaurant.currency)
          : experience.restaurant.locale
      }
      taxLabel={experience.restaurant.taxLabel ?? 'Tax'}
      restaurantName={experience.restaurant.name}
      loyaltyEnabled={experience.restaurant.loyaltyEnabled && experience.showLoyalty}
      loyaltyEarnRateX100={experience.restaurant.loyaltyEarnRateX100}
      slug={experience.restaurant.slug}
      basePath={qrPath(experience.publicId)}
      qrCode={experience.publicId}
      requiresTable={experience.askTable}
      branchCode={branch.code}
      showCoupon={appearance.checkoutShowCoupon}
      showName={appearance.checkoutShowName}
      showPhone={appearance.checkoutShowPhone}
      showNote={appearance.checkoutShowNote}
      showPointsEarned={appearance.checkoutShowPointsEarned}
      detailsHeading={appearance.checkoutDetailsHeading}
      phoneHint={appearance.checkoutPhoneHint}
    />
  )
}
