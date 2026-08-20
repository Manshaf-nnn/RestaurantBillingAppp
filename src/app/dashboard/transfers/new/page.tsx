import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { TransferBuilder } from '@/features/transfers/components/transfer-builder'
import { getTransferBuilderData } from '@/features/transfers/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'New transfer' }

export default async function NewTransferPage() {
  const user = await requirePagePermission(PERMISSIONS.TRANSFER_REQUEST, '/dashboard/transfers/new')
  const data = await getTransferBuilderData(user.restaurantId)

  return (
    <>
      <Link
        href="/dashboard/transfers"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Transfers
      </Link>
      <PageHeader title="New transfer" description="Move stock from one location to another." />
      <TransferBuilder locations={data.locations} stockByBranch={data.stockByBranch} />
    </>
  )
}
