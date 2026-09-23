import { notFound } from 'next/navigation'

import { resolvePublicBranch } from '@/features/branches/public-branch'
import { CartProvider } from '@/features/orders/cart-store'
import { resolveExperience } from '@/features/qr/queries'

/**
 * A QR menu's shell (ar.md §1).
 *
 * ── Why this is its own tree and not a variant of `/order` ──────────────────
 *
 * §2 and §29 insist the existing QR ordering flow keeps working exactly as it
 * does. Keeping these screens on separate routes makes that provable rather
 * than argued: nothing under `/order` changes behaviour, and a restaurant that
 * never opens the QR-menu screen is untouched by every line of this.
 *
 * ── Why nothing here reads a cookie ─────────────────────────────────────────
 *
 * The code in the path identifies the restaurant, the branch AND the
 * configuration, all at once, so none of the three can be dropped by a
 * navigation or go stale. `/order/[slug]/[branch]/layout.tsx` documents what
 * happens otherwise: a branch that lived in a cookie fell back to the default
 * one, and guests browsed the wrong menu at the wrong prices with nothing on
 * screen to say so.
 *
 * The branch is still re-resolved through `resolvePublicBranch` rather than
 * trusted from the row, so a location that has since been closed, deleted or
 * turned into a warehouse stops serving a menu.
 */
export default async function QrLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  const experience = await resolveExperience(code)
  if (!experience) notFound()

  const branch = await resolvePublicBranch(experience.restaurantId, experience.branch.code).catch(
    () => null,
  )
  if (!branch) notFound()

  return (
    <div className="min-h-dvh bg-background">
      {/*
       * The same cart key as `/order`, deliberately: one guest, one device,
       * one restaurant, one basket. Keying it by experience would be a second
       * cart system, and a guest who moved between two codes would find their
       * food had vanished.
       *
       * A menu-only experience mounts the provider too — `MenuBrowser` and
       * `ItemSheet` call `useCart()` unconditionally — it simply never writes
       * to it, because `ordering={false}` removes every path into the basket.
       */}
      <CartProvider restaurantId={experience.restaurantId}>
        <div className="relative mx-auto min-h-dvh w-full max-w-md overflow-x-clip bg-background shadow-2xl sm:my-0">
          {children}
        </div>
      </CartProvider>
    </div>
  )
}
