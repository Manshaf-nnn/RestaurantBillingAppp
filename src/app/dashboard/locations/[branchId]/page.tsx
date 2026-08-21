import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { getLocationDetail, listTransfers } from '@/features/transfers/queries'
import { StorageForm } from '@/features/branches/components/storage-form'
import { LocationEditForm } from '@/features/branches/components/location-edit-form'
import { AddStockForm } from '@/features/branches/components/add-stock-form'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, ROLE_LABELS, can, canManageLocation } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Location' }

export default async function LocationPage({
  params,
}: {
  params: Promise<{ branchId: string }>
}) {
  const { branchId } = await params
  const user = await requirePagePermission(PERMISSIONS.BRANCH_VIEW, `/dashboard/locations/${branchId}`)
  const restaurant = await requireRestaurant(user.restaurantId)
  const canManage = can(user, PERMISSIONS.BRANCH_MANAGE)
  const [{ branch, stock }, transfers, items, staff] = await Promise.all([
    getLocationDetail({ restaurantId: user.restaurantId, branchId }),
    listTransfers({ restaurantId: user.restaurantId, branchId, limit: 10 }),
    prisma.inventoryItem.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true },
      orderBy: { name: 'asc' },
    }),
    // Only fetched for the edit form, which nobody else sees.
    canManage
      ? prisma.user.findMany({
          where: { restaurantId: user.restaurantId, deletedAt: null, isActive: true },
          select: { id: true, name: true, role: true, permissions: true },
          orderBy: { name: 'asc' },
        })
      : [],
  ])
  const money = (m: number) => formatMoney(m, restaurant.currency)

  // Who can be put in charge here: judged on BRANCH_MANAGE, so a role that
  // gains the permission later is offered without this list being touched.
  const managers = staff
    .filter((member) => canManageLocation(member))
    .map((member) => ({ id: member.id, name: member.name, roleLabel: ROLE_LABELS[member.role] }))

  const value = stock.reduce((s, r) => s + r.value, 0)
  const inbound = stock.filter((r) => r.inTransit > 0)

  return (
    <>
      <Link
        href="/dashboard/locations"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Locations
      </Link>
      <PageHeader
        title={branch.name}
        description={[
          branch.type.replace(/_/g, ' ').toLowerCase(),
          branch.managerName && `managed by ${branch.managerName}`,
          branch.phone,
          !branch.isActive && 'not in use',
        ].filter(Boolean).join(' · ')}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Figure label="Stock value" value={money(value)} />
        <Figure label="Items held" value={String(stock.filter((s) => s.available !== 0).length)} />
        <Figure label="Inbound lines" value={String(inbound.length)} />
      </div>

      {canManage && (
        <div className="mb-5">
          <LocationEditForm
            location={{
              id: branch.id,
              name: branch.name,
              code: branch.code,
              type: branch.type,
              address: branch.address,
              phone: branch.phone,
              isActive: branch.isActive,
              isDefault: branch.isDefault,
              managerId: branch.managerId,
              openingHours: branch.openingHours,
            }}
            managers={managers}
          />
        </div>
      )}

      {can(user, PERMISSIONS.INVENTORY_MANAGE) && (
        <div className="mb-5">
          <AddStockForm
            branchId={branch.id}
            branchName={branch.name}
            items={items}
            shelves={branch.storageLocations}
            currency={restaurant.currency}
          />
        </div>
      )}

      {can(user, PERMISSIONS.BRANCH_MANAGE) && (
        <div className="mb-5">
          <StorageForm branchId={branch.id} existing={branch.storageLocations} />
        </div>
      )}

      <SectionCard
        title="Stock here"
        description="Available is what is on the shelf. Reserved is promised to a transfer that has not left. In transit is on its way here."
      >
        {stock.length === 0 ? (
          <EmptyState title="Nothing held here yet" description="Stock appears once something is received or transferred in." />
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[38rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 text-right font-medium">Available</th>
                  <th className="pb-2 pr-3 text-right font-medium">Reserved</th>
                  <th className="pb-2 pr-3 text-right font-medium">In transit</th>
                  <th className="pb-2 pr-3 text-right font-medium">Free</th>
                  <th className="pb-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stock.map((row) => (
                  <tr key={row.itemId}>
                    <td className="py-2.5 pr-3">
                      <Link href={`/dashboard/inventory/${row.itemId}`} className="font-medium text-primary underline-offset-2 hover:underline">
                        {row.name}
                      </Link>
                      {row.level && (
                        <Badge className="ml-2" variant={row.level === 'OUT_OF_STOCK' ? 'destructive' : 'secondary'}>
                          {row.level.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{row.available} {row.unit.toLowerCase()}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{row.reserved || '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-amber-600 dark:text-amber-400">{row.inTransit || '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums font-medium">{row.free}</td>
                    <td className="py-2.5 text-right tabular-nums text-muted-foreground">{money(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {transfers.length > 0 && (
        <SectionCard title="Recent transfers" description="Stock moving in or out of here.">
          <ul className="divide-y divide-border">
            {transfers.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <span className="font-medium tabular-nums">{t.number}</span>
                <span className="text-muted-foreground">{t.fromName} → {t.toName}</span>
                <Badge variant={t.status === 'COMPLETED' ? 'success' : 'secondary'}>
                  {t.status.replace(/_/g, ' ').toLowerCase()}
                </Badge>
                {t.hasVariance && <Badge variant="destructive">variance</Badge>}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}
