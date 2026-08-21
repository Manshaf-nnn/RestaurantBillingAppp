import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { getLocationDetail, listTransfers } from '@/features/transfers/queries'
import { StorageForm } from '@/features/branches/components/storage-form'
import { LocationEditForm } from '@/features/branches/components/location-edit-form'
import { AddStockForm } from '@/features/branches/components/add-stock-form'
import { ManagerCredentials } from '@/features/branches/components/manager-credentials'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, ROLE_LABELS, can, canAccessBranch, canManageLocation } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Location' }

/** Ordered the way a week is read, not the way an object happens to key. */
const DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
] as const

export default async function LocationPage({
  params,
}: {
  params: Promise<{ branchId: string }>
}) {
  const { branchId } = await params
  const user = await requirePagePermission(PERMISSIONS.BRANCH_VIEW, `/dashboard/locations/${branchId}`)
  const restaurant = await requireRestaurant(user.restaurantId)
  const canManage = can(user, PERMISSIONS.BRANCH_MANAGE)
  const [detail, transfers, items, staff] = await Promise.all([
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
  /*
   * The worst of the gaps: BRANCH_VIEW is held by cashiers and warehouse
   * staff, and this page shows another site's stock, value, team roster, sales
   * — and, to anyone with BRANCH_MANAGE, its manager's sign-in credentials.
   * Typing another branch's id was enough.
   */
  if (!canAccessBranch(user, branchId)) notFound()

  const { branch, stock, team, incoming, receipts, sales } = detail
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
                      {/*
                        Which shelf it is actually on, when it is split across
                        more than one. This has been computed by
                        getLocationDetail since it was written and thrown away
                        by every render — so a storekeeper could see that the
                        location holds 40kg and not that 38 are in the cold room
                        and 2 are by the door.
                      */}
                      {row.shelves.length > 0 ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {row.shelves
                            .map((sh) => `${sh.name}: ${sh.available}`)
                            .join(' · ')}
                        </p>
                      ) : null}
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

      {/*
        Opening hours, readable.
        
        They have always been editable on the form above and visible nowhere —
        so anyone without BRANCH_MANAGE, which is most people, could not find
        out when their own site opens.
      */}
      {branch.openingHours ? (
        <div className="mt-5">
          <SectionCard
            title="Opening hours"
            description="This location keeps its own hours."
          >
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {DAYS.map(([key, label]) => {
                const day = branch.openingHours?.[key]
                return (
                  <div key={key} className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums">
                      {!day || day.closed ? (
                        <span className="text-muted-foreground">Closed</span>
                      ) : (
                        `${day.open} – ${day.close}`
                      )}
                    </dd>
                  </div>
                )
              })}
            </dl>
          </SectionCard>
        </div>
      ) : null}

      {/* ── who works here ──────────────────────────────────────── */}
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <SectionCard
          title="Manager"
          description="Whoever is named here is confined to this location and sees only its figures."
          className="lg:col-span-1"
        >
          {branch.manager ? (
            <>
              <p className="font-medium">{branch.manager.name}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {[branch.manager.staffCode, branch.manager.phone].filter(Boolean).join(' · ') ||
                  'No phone on file'}
              </p>

              {canManage && branch.manager.signInCode ? (
                <ManagerCredentials
                  className="mt-4"
                  name={branch.manager.name}
                  email={branch.manager.email}
                  signInCode={branch.manager.signInCode}
                  locationName={branch.name}
                />
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  {branch.manager.email}
                  {canManage && !branch.manager.signInCode
                    ? ' — no sign-in code; issue one from Staff → Sign-in codes.'
                    : ''}
                </p>
              )}
            </>
          ) : (
            <EmptyState
              title="Nobody runs this location"
              description={
                canManage
                  ? 'Name someone below and they are moved here, or add a new manager from the Locations page.'
                  : 'No manager has been named yet.'
              }
            />
          )}
        </SectionCard>

        <SectionCard
          title="Working here"
          description="Everyone confined to this location. People who see every site are not listed."
          className="lg:col-span-2"
        >
          {team.length === 0 ? (
            <EmptyState
              title="Nobody assigned"
              description="Staff with no location see every site. Assign someone from the Staff screen to confine them here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {team.map((member) => (
                <li key={member.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                  <span className="font-medium">{member.name}</span>
                  {member.staffCode ? (
                    <Badge variant="secondary">{member.staffCode}</Badge>
                  ) : null}
                  <span className="text-muted-foreground">
                    {ROLE_LABELS[member.role as keyof typeof ROLE_LABELS] ?? member.role}
                  </span>
                  {member.id === branch.managerId ? <Badge variant="success">Manager</Badge> : null}
                  {!member.isActive ? <Badge variant="secondary">switched off</Badge> : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {member.lastLoginAt ? (
                      <>
                        last in <LocalDateTime value={member.lastLoginAt} />
                      </>
                    ) : (
                      'never signed in'
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {can(user, PERMISSIONS.STAFF_VIEW) ? (
            <Link
              href="/dashboard/staff"
              className="mt-3 inline-block text-sm text-primary hover:underline"
            >
              Manage staff →
            </Link>
          ) : null}
        </SectionCard>
      </div>

      {/* ── takings ─────────────────────────────────────────────── */}
      {can(user, PERMISSIONS.ANALYTICS_VIEW) ? (
        <div className="mt-5">
          <SectionCard
            title="Takings"
            description={`Orders placed here over the last ${sales.days} days. Unpaid is all time \u2014 a debt does not stop existing because it is old.`}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure label={`Revenue (${sales.days}d)`} value={money(sales.revenue)} />
              <Figure label={`Orders (${sales.days}d)`} value={String(sales.orders)} />
              <Figure label="Unpaid, all time" value={money(sales.unpaid)} />
            </div>
            <Link
              href={`/dashboard?branch=${branch.id}`}
              className="mt-3 inline-block text-sm text-primary hover:underline"
            >
              Open the dashboard for {branch.name} →
            </Link>
          </SectionCard>
        </div>
      ) : null}

      {/* ── purchases in ────────────────────────────────────────── */}
      {can(user, PERMISSIONS.PURCHASE_VIEW) && (incoming.length > 0 || receipts.length > 0) ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <SectionCard
            title="On its way here"
            description="Approved orders being delivered to this location."
          >
            {incoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing on order for here.</p>
            ) : (
              <ul className="divide-y divide-border">
                {incoming.map((po) => (
                  <li key={po.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                    <Link
                      href={`/dashboard/purchases/${po.id}`}
                      className="font-medium tabular-nums hover:underline"
                    >
                      {po.number}
                    </Link>
                    {po.supplierId && po.supplierName ? (
                      <Link
                        href={`/dashboard/suppliers/${po.supplierId}`}
                        className="text-muted-foreground hover:underline"
                      >
                        {po.supplierName}
                      </Link>
                    ) : null}
                    <Badge variant="secondary">{po.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                    {po.expectedAt ? (
                      <span className="text-xs text-muted-foreground">
                        due <LocalDateTime value={po.expectedAt} />
                      </span>
                    ) : null}
                    <span className="ml-auto tabular-nums">{money(po.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Delivered here" description="Goods actually taken in at this location.">
            {receipts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deliveries yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {receipts.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                    <Link
                      href={`/dashboard/purchases/${r.purchaseId}/receipts/${r.id}`}
                      className="font-medium tabular-nums hover:underline"
                    >
                      {r.number}
                    </Link>
                    <span className="text-muted-foreground">{r.supplierName ?? 'No supplier'}</span>
                    {r.supplierRef ? (
                      <span className="text-xs text-muted-foreground">inv {r.supplierRef}</span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      <LocalDateTime value={r.receivedAt} />
                    </span>
                    <span className="tabular-nums">{money(r.value)}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      ) : null}

      {transfers.length > 0 && (
        <SectionCard title="Recent transfers" description="Stock moving in or out of here." className="mt-5">
          <ul className="divide-y divide-border">
            {transfers.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <Link
                  href={`/dashboard/transfers/${t.id}`}
                  className="font-medium tabular-nums hover:underline"
                >
                  {t.number}
                </Link>
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
