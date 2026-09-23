import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { resolvePublicBranch } from '@/features/branches/public-branch'
import { getGuestAppearance } from '@/features/guest/queries'
import { narrowAppearance } from '@/features/guest/appearance'
import { isOpenNow, parseOpeningHours, todayLabel } from '@/lib/opening-hours'
import { askedForPreview, qrAccess } from '@/features/qr/access'
import { QrEntry, type EntryField } from '@/features/qr/components/qr-entry'
import { QrOpenBeacon } from '@/features/qr/components/qr-open-beacon'
import { qrPath } from '@/features/qr/guest-path'
import { categoriesFor, fieldsFor, resolveExperience } from '@/features/qr/queries'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>
}): Promise<Metadata> {
  const { code } = await params
  const experience = await resolveExperience(code)
  // Never the experience's internal name — that is the owner's word for it.
  return { title: experience ? experience.restaurant.name : 'Menu' }
}

/**
 * The entry screen for a QR menu (ar.md §5, §6, §7, §20).
 *
 * When the owner has configured nothing to ask, there is nothing to show: the
 * guest goes straight to the menu, which is §21 — a code created with just a
 * name and a branch behaves exactly like the existing QR flow. An ordering
 * code still stops here for the table number, because that question has always
 * been asked and the order cannot be placed without it.
 */
export default async function QrEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ code }, query] = await Promise.all([params, searchParams])

  const experience = await resolveExperience(code)
  if (!experience) notFound()

  const preview = askedForPreview(query.preview)
  const access = await qrAccess({ experience, asked: preview })
  if (!access.allowed) notFound()

  const branch = await resolvePublicBranch(experience.restaurantId, experience.branch.code).catch(
    () => null,
  )
  if (!branch) notFound()

  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { id: experience.restaurantId },
    select: { openingHours: true, timezone: true, coverUrl: true, tagline: true },
  })
  const hours = parseOpeningHours(restaurant.openingHours)
  const appearance = narrowAppearance(await getGuestAppearance(experience.restaurantId), experience)

  const ordering = experience.type === 'ORDERING'
  const identify = experience.identifyCustomer
  const askCategory = experience.askCustomerCategory

  const categories = askCategory ? await categoriesFor(experience) : []

  /*
   * Nothing to ask and nothing to seat — so do not make them tap through an
   * empty screen. A menu-only code with no questions IS just a menu.
   */
  if (!ordering && !identify && !askCategory) {
    redirect(qrPath(code, 'menu') + (preview ? '?preview=1' : ''))
  }

  /*
   * Every field the guest could be asked, general and per-category, sent in
   * one go: choosing a category re-renders from client state rather than
   * making a round trip in the middle of a form. HIDDEN rows never leave the
   * server.
   */
  const everyCategory = [null, ...categories.map((category) => category.id)]
  const seen = new Set<string>()
  const fields: EntryField[] = []
  for (const categoryId of everyCategory) {
    for (const field of fieldsFor(experience.fields, categoryId)) {
      const id = `${field.key}::${field.categoryId ?? ''}`
      if (seen.has(id)) continue
      seen.add(id)
      fields.push({
        key: field.key,
        label: field.label,
        type: field.type,
        rule: field.rule === 'REQUIRED' ? 'REQUIRED' : 'OPTIONAL',
        categoryId: field.categoryId,
      })
    }
  }

  const table = typeof query.t === 'string' ? query.t.toUpperCase().slice(0, 10) : ''

  return (
    <>
      {/* Counted once a session, from the browser — never during this render. */}
      {access.preview ? null : <QrOpenBeacon code={experience.publicId} />}
      <QrEntry
        code={experience.publicId}
        slug={experience.restaurant.slug}
        branchCode={branch.code}
        restaurantName={experience.restaurant.name}
        /*
         * The code's own welcome line when it has one, else the restaurant's.
         * A takeaway poster and a table card can say different things without
         * being different screens.
         */
        tagline={experience.description ?? restaurant.tagline}
        logoUrl={experience.restaurant.logoUrl}
        coverUrl={restaurant.coverUrl}
        isOpen={isOpenNow(hours, restaurant.timezone)}
        openingLabel={todayLabel(hours, restaurant.timezone)}
        appearance={appearance}
        askTable={experience.askTable}
        ordering={ordering}
        identify={identify}
        askCategory={askCategory}
        categories={categories}
        fields={identify ? fields : []}
        initialTable={table}
        preview={access.preview}
      />
    </>
  )
}
