import type { Metadata } from 'next'

import { requirePageSuperAdmin } from '@/server/auth/guard'
import { listPlatformRestaurants } from '@/features/platform/queries'

export const metadata: Metadata = { title: 'Media backups' }

export default async function AdminMediaPage() {
  await requirePageSuperAdmin('/admin')

  const restaurants = await listPlatformRestaurants()

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Media backups</h1>
      <p className="text-sm text-muted-foreground">Restore backed-up media for a restaurant (Cloudinary required).</p>

      <div className="grid gap-4">
        {restaurants.map((r) => (
          <div key={r.id} className="p-4 border rounded bg-white">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{r.name}</div>
                <div className="text-sm text-muted-foreground">{r.slug}</div>
              </div>
              <form method="post" action="/api/admin/media/restore">
                <input type="hidden" name="restaurantId" value={r.id} />
                <input type="hidden" name="dryRun" value="true" />
                <button type="submit" className="btn">Dry-run restore</button>
              </form>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
