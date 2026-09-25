import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { LocationsManager } from '@/features/qr/components/locations-manager'
import { listLocations } from '@/features/qr/locations'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Delivery locations' }

/**
 * Where deliveries go.
 *
 * Sits under QR rather than under Settings because it is only ever reached
 * through a QR code that asks for it — the toggle that turns it on lives on
 * the code, and an owner setting one up should find the list beside it rather
 * than three screens away.
 */
export default async function DeliveryLocationsPage() {
  const user = await requirePagePermission(PERMISSIONS.QR_MANAGE, '/dashboard/qr/locations')
  const selection = await selectedBranch(user)

  const [rows, categories, branches] = await Promise.all([
    listLocations({ restaurantId: user.restaurantId, branchIds: selection.branchIds }),
    /*
     * The CRM's own categories — the same rows a QR code offers a guest to
     * pick from, so "for Campus Student" here and "I am a Campus Student"
     * there are the same thing rather than two lists that drift.
     */
    prisma.customerCategory.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.branch.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        ...(visibleBranchIds(user) ? { id: { in: visibleBranchIds(user)! } } : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ])

  return (
    <>
      <PageHeader
        title="Delivery locations"
        description="The places a delivery goes. Guests pick one at checkout instead of typing an address, so every ticket names the same place the same way."
      />
      <LocationsManager rows={rows} categories={categories} branches={branches} />
    </>
  )
}
