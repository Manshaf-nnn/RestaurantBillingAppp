import type { Metadata } from 'next'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { PlatformConsole } from '@/features/platform/components/platform-console'
import { getPlatformStats, listPlatformRestaurants, listRecentPlatformFeedback } from '@/features/platform/queries'
import { appUrl } from '@/lib/env'
import { listPackages } from '@/features/platform/feature-service'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Platform admin' }

export default async function AdminPage() {
  await requirePageSuperAdmin('/admin')

  const [restaurants, stats, recentFeedback, packages] = await Promise.all([
    listPlatformRestaurants(),
    getPlatformStats(),
    listRecentPlatformFeedback(),
    listPackages(),
  ])

  return (
    <>
      <AutoRefresh intervalMs={12000} scope="none" />
      <PageHeader
        title="Restaurants"
        description="Review sign-ups, approve new restaurants, and manage every tenant on the platform."
      />
      <PlatformConsole
        restaurants={restaurants}
        stats={stats}
        recentFeedback={recentFeedback}
        appUrl={appUrl()}
        packages={packages
          .filter((pkg) => pkg.isActive)
          .map((pkg) => ({ id: pkg.id, name: pkg.name, featureKeys: pkg.featureKeys }))}
      />
    </>
  )
}
