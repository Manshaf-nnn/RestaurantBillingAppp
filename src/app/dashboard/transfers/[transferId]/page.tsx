import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { TransferPanel } from '@/features/transfers/components/transfer-panel'
import { getTransferDetail } from '@/features/transfers/queries'
import { PERMISSIONS, can} from '@/lib/rbac'
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
          approve: can(user, PERMISSIONS.TRANSFER_APPROVE),
          dispatch: can(user, PERMISSIONS.TRANSFER_DISPATCH),
          receive: can(user, PERMISSIONS.TRANSFER_RECEIVE),
        }}
      />
    </>
  )
}
