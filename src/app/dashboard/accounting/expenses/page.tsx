import type { Metadata } from 'next'

import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { CategoryManager } from '@/features/outgoing-payments/components/category-manager'
import { listExpenseCategories, listOutgoingPayments } from '@/features/outgoing-payments/queries'
import { ensureDefaultCategories } from '@/features/outgoing-payments/service'
import { formatMoney } from '@/lib/money'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Expenses' }

/**
 * The formal expense book — rent, salaries, utilities — by category and
 * status. Deliberately NOT petty cash: small drawer money keeps its own lane.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/accounting/expenses')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)
  const selection = await selectedBranch(user, await searchParams)

  await ensureDefaultCategories(user.restaurantId)

  const [expenses, categories] = await Promise.all([
    listOutgoingPayments({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
    }).then((rows) => rows.filter((row) => row.kind === 'EXPENSE')),
    listExpenseCategories(user.restaurantId),
  ])

  const paid = expenses.filter((row) => row.status === 'PAID')
  const pending = expenses.filter((row) => row.status === 'SUBMITTED' || row.status === 'APPROVED')
  const sum = (rows: typeof expenses) => rows.reduce((total, row) => total + row.amount, 0)

  const byCategory = new Map<string, number>()
  for (const row of paid) {
    const key = row.categoryName ?? 'Uncategorised'
    byCategory.set(key, (byCategory.get(key) ?? 0) + row.amount)
  }

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Formal business costs, approved and on the record. Raise one from Payments out."
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <StatCard label="Paid" value={money(sum(paid))} hint={`${paid.length} expense(s)`} href="/dashboard/accounting/payments" />
        <StatCard label="In the pipeline" value={money(sum(pending))} hint="submitted or approved, not yet paid" tone={pending.length > 0 ? 'warning' : 'default'} href="/dashboard/accounting/payments" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Paid, by category">
          {byCategory.size === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No paid expenses yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {[...byCategory.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([category, amount]) => (
                  <li key={category} className="flex justify-between py-2">
                    <span>{category}</span>
                    <span className="font-semibold tabular-nums">{money(amount)}</span>
                  </li>
                ))}
            </ul>
          )}
        </SectionCard>
        <CategoryManager
          categories={categories}
          canManage={can(user, PERMISSIONS.ACCOUNTING_EXPENSE_MANAGE)}
        />
      </div>
    </>
  )
}
