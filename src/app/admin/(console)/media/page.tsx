import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'

import { requirePageSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { listPlatformRestaurants, listRecentRestaurantMenuSnapshots } from '@/features/platform/queries'

export const metadata: Metadata = { title: 'Media backups' }

export default async function AdminMediaPage() {
  await requirePageSuperAdmin('/admin')

  const restaurants = await listPlatformRestaurants()
  const [backupCounts, recentMenu] = await Promise.all([
    Promise.all(
      restaurants.map(async (restaurant) => ({
        restaurantId: restaurant.id,
        count: await prisma.mediaBackup.count({ where: { restaurantId: restaurant.id } }),
      })),
    ),
    listRecentRestaurantMenuSnapshots(12),
  ])
  const countByRestaurant = new Map(backupCounts.map((entry) => [entry.restaurantId, entry.count]))

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Media backups</h1>
          <p className="text-sm text-muted-foreground">Restore backed-up media for a restaurant. Use dry-run first.</p>
        </div>
        <Link href="/admin" className="text-sm font-medium text-primary hover:underline">
          Back to restaurants
        </Link>
      </div>

      <div className="grid gap-4">
        {restaurants.map((restaurant) => {
          const count = countByRestaurant.get(restaurant.id) ?? 0
          return (
            <div key={restaurant.id} className="rounded-xl border bg-card p-4 shadow-soft">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="font-medium">{restaurant.name}</div>
                  <div className="text-sm text-muted-foreground">/{restaurant.slug}</div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                    {count} backups
                  </span>
                  <form method="post" action="/api/admin/media/restore">
                    <input type="hidden" name="restaurantId" value={restaurant.id} />
                    <input type="hidden" name="dryRun" value="true" />
                    <button type="submit" className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
                      Dry-run restore
                    </button>
                  </form>
                  <form method="post" action="/api/admin/media/restore">
                    <input type="hidden" name="restaurantId" value={restaurant.id} />
                    <input type="hidden" name="dryRun" value="false" />
                    <button type="submit" className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
                      Restore all
                    </button>
                  </form>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-soft">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Recently synced menu items</h2>
          <span className="text-xs text-muted-foreground">Live mirror from tenant uploads</span>
        </div>

        {recentMenu.length === 0 ? (
          <p className="text-sm text-muted-foreground">No synced menu items yet.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {recentMenu.map((item) => (
              <div key={item.id} className="rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center gap-3">
                  {item.imageUrl ? (
                    <div className="relative h-12 w-12 overflow-hidden rounded-md border bg-background">
                      <Image src={item.imageUrl} alt={item.name} fill className="object-cover" sizes="48px" />
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{item.name}</div>
                    <div className="text-xs text-muted-foreground">{item.restaurantName}</div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{item.entityType}</span>
                  {item.price !== null ? <span>₹{(item.price / 100).toFixed(2)}</span> : <span>—</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
