import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { PlatformConsole } from '@/features/platform/components/platform-console'
import { getPlatformStats, listPlatformRestaurants } from '@/features/platform/queries'
import { appUrl } from '@/lib/env'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Platform admin' }

export default async function AdminPage() {
  await requirePageSuperAdmin('/admin')

  const [restaurants, stats] = await Promise.all([
    listPlatformRestaurants(),
    getPlatformStats(),
  ])

  return (
    <>
      <PageHeader
        title="Restaurants"
        description="Review sign-ups, approve new restaurants, and manage every tenant on the platform."
      />
      <PlatformConsole restaurants={restaurants} stats={stats} appUrl={appUrl()} />
    </>
  )
}
