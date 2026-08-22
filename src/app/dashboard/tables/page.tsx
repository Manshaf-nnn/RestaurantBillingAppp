import type { Metadata } from 'next'

import { TablesManager } from '@/features/floor/components/tables-manager'
import { can, PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Tables' }

export default async function TablesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.TABLE_VIEW, '/dashboard/tables')

  /*
   * A table stands in one building — table 4 at Kandy and table 4 at Colombo
   * are different tables — so a chosen location narrows the list, strictly.
   *
   * This used to fall back to showing tables with no branch at every location,
   * because the column was nullable and nothing wrote it, so a strict filter
   * would have shown an empty floor to a restaurant that plainly had tables.
   * Every row now has a branch and the column is NOT NULL, so the fallback is
   * not just unnecessary — it would be a lie.
   */
  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)

  /*
   * The form needs to know where it is adding.
   *
   * Reading was already scoped and writing was not: the page passed the client
   * neither the selected branch nor a list of branches, so the add-table form
   * could not name one even in principle. `saveTable` then fell through
   * `resolveBranchId` to the restaurant's DEFAULT branch — which for an owner,
   * who has no home branch, is every time. Every table in this database sits at
   * its restaurant's default branch as a result, and adding one at Branch 01
   * either vanished or came back as "Table 1 already exists at this location"
   * against a floor plan that was visibly empty.
   */
  const reach = visibleBranchIds(user)
  const [tables, allBranches] = await Promise.all([
    prisma.restaurantTable.findMany({
      where: {
        restaurantId: user.restaurantId,
        isActive: true,
        ...(branchId ? { branchId } : {}),
      },
      orderBy: [{ area: 'asc' }, { sortOrder: 'asc' }, { number: 'asc' }],
      include: {
        branch: { select: { name: true } },
        _count: {
          select: { orders: { where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } } },
        },
      },
    }),
    // Guests sit at branches. A warehouse and a production house have no
    // dining room, so offering one as a home for a table would be offering a
    // mistake — hence the type filter rather than `listBranches`.
    prisma.branch.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        isActive: true,
        type: 'BRANCH',
        ...(reach ? { id: { in: reach } } : {}),
      },
      select: { id: true, name: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
  ])

  const branches = allBranches

  return (
    <TablesManager
      canManage={can(user, PERMISSIONS.TABLE_MANAGE)}
      branches={branches}
      // What the switcher is showing, so the form opens on the right location.
      // Null means "All locations", and then the form makes the owner choose.
      selectedBranchId={selection.branchId}
      tables={tables.map((table) => ({
        id: table.id,
        number: table.number,
        label: table.label,
        area: table.area,
        capacity: table.capacity,
        status: table.status,
        notes: table.notes,
        branchId: table.branchId,
        branchName: table.branch.name,
        openOrders: table._count.orders,
      }))}
    />
  )
}
