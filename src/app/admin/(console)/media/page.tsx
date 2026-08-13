import type { Metadata } from 'next'
import Link from 'next/link'

import { requirePageSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { listPlatformRestaurants } from '@/features/platform/queries'

export const metadata: Metadata = { title: 'Media backups' }

export default async function AdminMediaPage() {
  await requirePageSuperAdmin('/admin')

  const restaurants = await listPlatformRestaurants()
  const backupCounts = await Promise.all(
    restaurants.map(async (restaurant) => ({
      restaurantId: restaurant.id,
      count: await prisma.mediaBackup.count({ where: { restaurantId: restaurant.id } }),
    })),
  )
  const countByRestaurant = new Map(backupCounts.map((entry) => [entry.restaurantId, entry.count]))

  return (
    <div className="space-y-6">
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
    </div>
  )
}
