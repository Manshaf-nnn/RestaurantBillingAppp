import type { Metadata } from 'next'
import Link from 'next/link'
import { Building2, Factory, Store, Warehouse } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { listLocations } from '@/features/transfers/queries'
import { LocationForm } from '@/features/branches/components/location-form'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can} from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Locations' }

const TYPES = {
  BRANCH: { label: 'Branch', icon: Store },
  PRODUCTION_HOUSE: { label: 'Production house', icon: Factory },
  CENTRAL_WAREHOUSE: { label: 'Central warehouse', icon: Warehouse },
} as const

export default async function LocationsPage() {
  const user = await requirePagePermission(PERMISSIONS.BRANCH_VIEW, '/dashboard/locations')
  const restaurant = await requireRestaurant(user.restaurantId)
  const locations = await listLocations(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const totalValue = locations.reduce((s, l) => s + l.stockValue, 0)

  return (
    <>
      <PageHeader
        title="Locations"
        description="Branches, production houses and warehouses. Every one holds its own stock and shares one ledger."
        actions={can(user, PERMISSIONS.BRANCH_MANAGE) ? <LocationForm /> : null}
      />

      {locations.length === 0 ? (
        <SectionCard title="No locations">
          <EmptyState
            title="Nothing set up yet"
            description="Every restaurant gets one location automatically. Add more to run several sites."
          />
        </SectionCard>
      ) : (
        <>
          <div className="mb-5 rounded-lg border border-border p-3 text-sm">
            <span className="text-muted-foreground">Stock held across all locations</span>
            <span className="ml-2 font-semibold tabular-nums">{money(totalValue)}</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {locations.map((l) => {
              const meta = TYPES[l.type] ?? TYPES.BRANCH
              const Icon = meta.icon
              return (
                <Link
                  key={l.id}
                  href={`/dashboard/locations/${l.id}`}
                  className="rounded-xl border border-border p-4 transition hover:border-primary/50 hover:shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Icon className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="font-medium">{l.name}</p>
                        <p className="text-xs text-muted-foreground">{meta.label} · {l.code}</p>
                      </div>
                    </div>
                    {!l.isActive && <Badge variant="secondary">inactive</Badge>}
                  </div>

                  <dl className="mt-4 space-y-1.5 text-sm">
                    <Row label="Stock value" value={money(l.stockValue)} />
                    <Row label="Items held" value={String(l.itemsHeld)} />
                    {l.outOfStock > 0 && (
                      <Row label="Out of stock" value={String(l.outOfStock)} tone="bad" />
                    )}
                    {l.lowStock > 0 && (
                      <Row label="Low stock" value={String(l.lowStock)} tone="warn" />
                    )}
                    {l.inTransitLines > 0 && (
                      <Row label="Inbound" value={`${l.inTransitLines} in transit`} tone="warn" />
                    )}
                  </dl>
                </Link>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'bad' | 'warn' }) {
  const cls =
    tone === 'bad' ? 'text-red-600 dark:text-red-400'
      : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular-nums ${cls}`}>{value}</dd>
    </div>
  )
}
