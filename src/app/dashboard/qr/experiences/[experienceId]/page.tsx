import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { orderableBranches } from '@/features/branches/public-branch'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { listCustomerCategories } from '@/features/customers/service'
import { getManagedMenu } from '@/features/menu/queries'
import { toQrDataUrl } from '@/features/payments/service'
import { ExperienceEditor } from '@/features/qr/components/experience-editor'
import { qrPath } from '@/features/qr/guest-path'
import { experienceStats, getExperience, readIdList } from '@/features/qr/queries'
import { localeForCurrency } from '@/lib/money'
import { PERMISSIONS, canAccessBranch, visibleBranchIds } from '@/lib/rbac'
import { printableOrigin } from '@/lib/tenant-url'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'QR menu' }

/**
 * One QR menu: what it shows, what it asks, and the code to print (ar.md §4–§20).
 *
 * Everything on one page, in the order an owner thinks about it, with a real
 * default for every answer. There is no wizard to get lost in and no step that
 * must be completed — the code already works when this page first opens.
 */
export default async function QrExperiencePage({
  params,
  searchParams,
}: {
  params: Promise<{ experienceId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { experienceId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.QR_MANAGE,
    `/dashboard/qr/experiences/${experienceId}`,
  )
  // Read so the switcher stays in step with the rest of the dashboard; the
  // record's own branch is what actually decides access, below.
  await selectedBranch(user, await searchParams)

  const experience = await getExperience({ restaurantId: user.restaurantId, experienceId })
  if (!experience) notFound()
  // A code for a location this person has nothing to do with is not theirs to
  // read, id in the address bar or not.
  if (!canAccessBranch(user, experience.branchId)) notFound()

  const [restaurant, branches, categories, menu, stats] = await Promise.all([
    requireRestaurant(user.restaurantId),
    orderableBranches(user.restaurantId),
    listCustomerCategories({ restaurantId: user.restaurantId }),
    getManagedMenu(user.restaurantId, undefined, experience.branchId),
    experienceStats({ restaurantId: user.restaurantId, experienceId }),
  ])

  const allowed = visibleBranchIds(user)
  const reachable = branches.filter((branch) => allowed === null || allowed.includes(branch.id))

  const origin = await printableOrigin(restaurant)
  const link = `${origin}${qrPath(experience.publicId)}`

  return (
    <>
      <Link
        href="/dashboard/qr/experiences"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        QR menus
      </Link>

      <PageHeader
        title={experience.name}
        description={`${experience.type === 'MENU_ONLY' ? 'Menu only' : 'Takes orders'} · ${experience.branch.name}`}
      />

      <ExperienceEditor
        experience={{
          id: experience.id,
          publicId: experience.publicId,
          name: experience.name,
          description: experience.description,
          branchId: experience.branchId,
          type: experience.type,
          askTable: experience.askTable,
          isActive: experience.isActive,
          menuMode: experience.menuMode,
          menuCategoryIds: readIdList(experience.menuCategoryIds),
          menuFoodIds: readIdList(experience.menuFoodIds),
          identifyCustomer: experience.identifyCustomer,
          askCustomerCategory: experience.askCustomerCategory,
          customerCategoryIds: readIdList(experience.customerCategoryIds),
          showSearch: experience.showSearch,
          showPrices: experience.showPrices,
          showOffers: experience.showOffers,
          showLoyalty: experience.showLoyalty,
          fields: experience.fields.map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            rule: field.rule,
            categoryId: field.categoryId,
            sortOrder: field.sortOrder,
          })),
        }}
        branches={reachable.map((branch) => ({ id: branch.id, name: branch.name }))}
        customerCategories={categories.map((category) => ({ id: category.id, name: category.name }))}
        menuCategories={menu.categories.map((category) => ({
          id: category.id,
          name: category.name,
          items: menu.foods
            .filter((food) => food.category.id === category.id)
            .map((food) => ({ id: food.id, name: food.name })),
        }))}
        link={link}
        qrDataUrl={await toQrDataUrl(link)}
        previewPath={`${qrPath(experience.publicId)}?preview=1`}
        stats={stats}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
      />
    </>
  )
}
