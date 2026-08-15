import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'

import { requirePageSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { listPlatformRestaurants, listRecentRestaurantMenuSnapshots } from '@/features/platform/queries'

export const metadata: Metadata = { title: 'Image storage' }

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default async function AdminMediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePageSuperAdmin('/admin')

  const params = await searchParams
  const report = params.scanned
    ? {
        scanned: Number(params.scanned),
        safe: Number(params.safe ?? 0),
        imported: Number(params.imported ?? 0),
        missing: Number(params.missing ?? 0),
        dryRun: params.dryRun !== 'false',
      }
    : null

  const restaurants = await listPlatformRestaurants()
  const [assetStats, recentMenu] = await Promise.all([
    Promise.all(
      restaurants.map(async (restaurant) => ({
        restaurantId: restaurant.id,
        stats: await prisma.mediaAsset.aggregate({
          where: { restaurantId: restaurant.id },
          _count: true,
          _sum: { size: true },
        }),
      })),
    ),
    listRecentRestaurantMenuSnapshots(12),
  ])
  const statsByRestaurant = new Map(assetStats.map((entry) => [entry.restaurantId, entry.stats]))

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Image storage</h1>
          <p className="text-sm text-muted-foreground">
            Uploaded images are stored in the database, so they survive redeploys and Netlify
            account changes. Use the repair tool below only for images uploaded before this.
          </p>
        </div>
        <Link href="/admin" className="text-sm font-medium text-primary hover:underline">
          Back to restaurants
        </Link>
      </div>

      {report ? (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
          <p className="font-medium">
            {report.dryRun ? 'Dry run complete — nothing was changed.' : 'Repair complete.'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Scanned {report.scanned} image{report.scanned === 1 ? '' : 's'} · {report.safe} already
            safe · {report.imported}{' '}
            {report.dryRun ? 'can be imported' : 'imported into the database'} · {report.missing}{' '}
            unrecoverable
            {report.missing > 0 ? ' (those need re-uploading by the owner)' : ''}.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4">
        {restaurants.map((restaurant) => {
          const stats = statsByRestaurant.get(restaurant.id)
          const count = stats?._count ?? 0
          const size = stats?._sum.size ?? 0
          return (
            <div key={restaurant.id} className="rounded-xl border bg-card p-4 shadow-soft">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="font-medium">{restaurant.name}</div>
                  <div className="text-sm text-muted-foreground">/{restaurant.slug}</div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-success/10 px-2 py-1 text-xs font-medium text-success">
                    {count} image{count === 1 ? '' : 's'} secured · {formatBytes(size)}
                  </span>
                  <form method="post" action="/api/admin/media/restore">
                    <input type="hidden" name="restaurantId" value={restaurant.id} />
                    <input type="hidden" name="dryRun" value="true" />
                    <button type="submit" className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
                      Check images
                    </button>
                  </form>
                  <form method="post" action="/api/admin/media/restore">
                    <input type="hidden" name="restaurantId" value={restaurant.id} />
                    <input type="hidden" name="dryRun" value="false" />
                    <button type="submit" className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
                      Repair &amp; import
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
