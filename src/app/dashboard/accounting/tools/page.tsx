import type { Metadata } from 'next'
import Link from 'next/link'

import { AccountingCalculator } from '@/features/accounting/components/calculator'
import { WhatIf } from '@/features/accounting/components/what-if'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { resolveRange } from '@/features/reports/range'
import { getIngredientImpact } from '@/features/reports/what-if'
import type { CurrencyCode } from '@/lib/money'
import { cn } from '@/lib/utils'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Accounting tools' }

const TABS = [
  { key: 'calculator', label: 'Calculator' },
  { key: 'whatif', label: 'What if' },
] as const

type TabKey = (typeof TABS)[number]['key']

/**
 * The accountant's tools (acCal.md §2, §12): a calculator in the billing
 * engine's own math, and a price simulator. Everything on this page is
 * read-only — it can never change an accounting record.
 */
export default async function AccountingToolsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/accounting/tools')
  const restaurant = await requireRestaurant(user.restaurantId)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  const tab: TabKey = TABS.some((entry) => entry.key === str('tab')) ? (str('tab') as TabKey) : 'calculator'
  const selection = await selectedBranch(user, params)

  const items =
    tab === 'whatif'
      ? await prisma.inventoryItem.findMany({
          where: { restaurantId: user.restaurantId, isActive: true },
          select: { id: true, name: true, unit: true },
          orderBy: { name: 'asc' },
          take: 300,
        })
      : []
  const itemId = str('item')
  const impact =
    tab === 'whatif' && itemId
      ? await getIngredientImpact({
          restaurantId: user.restaurantId,
          itemId,
          range: resolveRange({ preset: 'LAST_30', timeZone: restaurant.timezone }),
          branchIds: selection.branchIds,
        })
      : null

  return (
    <>
      <PageHeader
        title="Tools"
        description="Quick sums in the same math the bills use, and a way to test a price change safely. Nothing here is saved."
      />

      <nav className="mb-5 flex gap-1 border-b">
        {TABS.map((entry) => (
          <Link
            key={entry.key}
            href={entry.key === 'calculator' ? '/dashboard/accounting/tools' : '/dashboard/accounting/tools?tab=whatif'}
            className={cn(
              'rounded-t-lg px-4 py-2 text-sm font-medium',
              tab === entry.key ? 'border border-b-0 bg-card text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {tab === 'calculator' ? (
        <AccountingCalculator
          currency={restaurant.currency as CurrencyCode}
          taxRateBps={restaurant.taxRateBps}
        />
      ) : (
        <WhatIf items={items} selected={impact} currency={restaurant.currency as CurrencyCode} />
      )}
    </>
  )
}
