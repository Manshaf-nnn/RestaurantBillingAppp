import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { TransferPanel } from '@/features/transfers/components/transfer-panel'
import { getTransferDetail } from '@/features/transfers/queries'
import { assertTransferSide } from '@/features/transfers/service'
import { PERMISSIONS, can, canAccessBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Transfer' }

export default async function TransferPage({
  params,
}: {
  params: Promise<{ transferId: string }>
}) {
  const { transferId } = await params
  const user = await requirePagePermission(PERMISSIONS.TRANSFER_VIEW, `/dashboard/transfers/${transferId}`)
  const detail = await getTransferDetail({ restaurantId: user.restaurantId, transferId })

  /*
   * A transfer between two other locations is none of a branch manager's
   * business. Without this the page happily opened it — the list was scoped but
   * the detail was not, so the id from a colleague's screen was enough.
   */
  assertTransferSide(user, detail, 'EITHER')

  /*
   * The buttons follow the same rule the actions enforce. Showing Dispatch to
   * the receiving branch and answering the click with "only someone at the
   * sending location can do that" teaches people the app is broken; the honest
   * version is not to offer it.
   */
  const atSource = canAccessBranch(user, detail.fromBranchId)
  const atDestination = canAccessBranch(user, detail.toBranchId)

  return (
    <>
      <Link
        href="/dashboard/transfers"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Transfers
      </Link>
      <PageHeader title={detail.number} description={`${detail.fromName} → ${detail.toName}`} />
      <TransferPanel
        detail={detail}
        can={{
          approve: atSource && can(user, PERMISSIONS.TRANSFER_APPROVE),
          dispatch: atSource && can(user, PERMISSIONS.TRANSFER_DISPATCH),
          receive: atDestination && can(user, PERMISSIONS.TRANSFER_RECEIVE),
        }}
      />
    </>
  )
}
