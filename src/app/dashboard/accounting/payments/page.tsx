import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PaymentConsole } from '@/features/outgoing-payments/components/payment-console'
import { ensureDefaultCategories } from '@/features/outgoing-payments/service'
import { visibleAccountsFor } from '@/features/payments/accounts'
import { listExpenseCategories, listOutgoingPayments } from '@/features/outgoing-payments/queries'
import { can, PERMISSIONS } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Payments out' }

/**
 * The accountant's worklist: money leaving the business, from draft to paid.
 * Recording is this desk's job; approving is deliberately the owner's.
 */
export default async function PaymentsOutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/accounting/payments')
  const restaurant = await requireRestaurant(user.restaurantId)
  const selection = await selectedBranch(user, await searchParams)

  await ensureDefaultCategories(user.restaurantId)

  const [rows, suppliers, categories, branches, accounts, balances] = await Promise.all([
    listOutgoingPayments({ restaurantId: user.restaurantId, branchIds: selection.branchIds }),
    prisma.supplier.findMany({
      where: { restaurantId: user.restaurantId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    listExpenseCategories(user.restaurantId).then((all) => all.filter((c) => c.isActive)),
    prisma.branch.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        isActive: true,
        ...(selection.branchIds ? { id: { in: selection.branchIds } } : {}),
      },
      select: { id: true, name: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
    /*
     * The accounts from Payment details, for "Pay from". Every active account
     * can be NAMED — that is the accountant's job. What is IN it is shown only
     * for the accounts this person may see (`balances` below): the owner sees
     * all of them, anybody else the ones the owner assigned.
     */
    prisma.paymentAccount.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true, bankName: true, accountNumber: true },
      orderBy: { name: 'asc' },
    }),
    visibleAccountsFor(user),
  ])
  const balanceOf = new Map(balances.map((row) => [row.accountId, row.balance]))

  return (
    <>
      <PageHeader
        title="Payments out"
        description="Draft it, submit it for the owner's sign-off, then pay it. A payment the owner raises is approved as it is submitted. A paid payment is immutable — corrections reverse."
        actions={
          <Link
            href="/dashboard/accounting/payments/report"
            className="inline-flex h-9 items-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted"
          >
            Money out report
          </Link>
        }
      />
      <PaymentConsole
        rows={rows}
        suppliers={suppliers}
        categories={categories}
        branches={branches}
        accounts={accounts.map((account) => ({
          id: account.id,
          name: [account.name, account.bankName, account.accountNumber ? `A/C ${account.accountNumber}` : null]
            .filter(Boolean)
            .join(' · '),
          balance: balanceOf.get(account.id) ?? null,
        }))}
        // The owner and administrators sign their own payments on submission.
        selfApproves={
          ['OWNER', 'ADMIN', 'SUPER_ADMIN'].includes(user.role) &&
          can(user, PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE)
        }
        defaultBranchId={selection.branchId ?? user.branchId ?? null}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        canCreate={can(user, PERMISSIONS.ACCOUNTING_PAYMENT_CREATE)}
        canPay={can(user, PERMISSIONS.ACCOUNTING_PAYMENT_PAY)}
      />
    </>
  )
}
