'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardCheck } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { openStockCountAction } from '../stock-actions'

/** Starts a count and drops the counter straight onto the sheet. */
export function StartCountButton() {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  const start = async () => {
    setBusy(true)
    const result = await openStockCountAction()
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    router.push(`/dashboard/inventory/counts/${result.data.id}`)
  }

  return (
    <Button onClick={start} disabled={busy}>
      <ClipboardCheck className="mr-2 h-4 w-4" />
      {busy ? 'Starting…' : 'Start a count'}
    </Button>
  )
}
