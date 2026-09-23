import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { readAppearance } from '@/features/guest/appearance'
import { GuestAppearanceEditor } from '@/features/settings/components/guest-appearance-editor'
import { PERMISSIONS } from '@/lib/rbac'
import { isOpenNow, parseOpeningHours, todayLabel } from '@/lib/opening-hours'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Guest experience' }

/**
 * What guests see when they scan (ar.md §13, §19).
 *
 * Restaurant-level, deliberately: a guest scanning the card on table 6 and a
 * guest scanning the takeaway poster should meet the same restaurant. So this
 * one page decides the welcome screen and the menu layout for the ordinary
 * table QR AND for every QR menu, and a QR menu's own switches only narrow it
 * for that code.
 *
 * Not branch-scoped for the same reason the loyalty scheme is not: it is the
 * business's face, not a site's.
 */
export default async function GuestExperiencePage() {
  const user = await requirePagePermission(PERMISSIONS.SETTINGS_MANAGE, '/dashboard/settings/guest')

  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { id: user.restaurantId },
    select: {
      name: true,
      tagline: true,
      logoUrl: true,
      coverUrl: true,
      timezone: true,
      openingHours: true,
      guestExperience: true,
    },
  })

  const hours = parseOpeningHours(restaurant.openingHours)

  return (
    <>
      <Link
        href="/dashboard/settings"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Settings
      </Link>

      <PageHeader
        title="Guest experience"
        description="What a guest sees when they scan any of your codes — the welcome screen and the menu. Changes apply to your table QR codes and your QR menus alike."
      />

      <GuestAppearanceEditor
        appearance={readAppearance(restaurant.guestExperience)}
        restaurantName={restaurant.name}
        tagline={restaurant.tagline}
        logoUrl={restaurant.logoUrl}
        coverUrl={restaurant.coverUrl}
        isOpen={isOpenNow(hours, restaurant.timezone)}
        openingLabel={todayLabel(hours, restaurant.timezone)}
      />
    </>
  )
}
