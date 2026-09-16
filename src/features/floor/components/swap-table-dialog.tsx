'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRightLeft } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ItemPicker } from '@/components/ui/item-picker'
import { Label } from '@/components/ui/label'
import { callAction } from '@/lib/use-action'
import { listSwapTargetsAction, swapTableAction } from '../actions'

/**
 * Move a sitting to an empty table (abc.md §3).
 *
 * One dialog, mounted wherever a table can be acted on — the cashier's bill,
 * the waiter's floor plan, the tables page — so the rule is the same
 * everywhere: pick an Empty table at this location, confirm, done. The
 * server decides what "empty" means (no sitting, no open order, no booking
 * in its window) and refuses anything else; the list here is a convenience
 * built from the same answer.
 */
export function SwapTableDialog({
  open,
  onOpenChange,
  table,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The occupied table whose sitting is moving. */
  table: { id: string; number: string } | null
}) {
  const router = useRouter()
  const [targets, setTargets] = React.useState<
    Array<{ id: string; number: string; label: string | null; area: string | null; capacity: number }>
  >([])
  const [loading, setLoading] = React.useState(false)
  const [toId, setToId] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  // Fresh each time it opens: another table may have emptied since.
  React.useEffect(() => {
    if (!open || !table) return
    setToId('')
    setLoading(true)
    void callAction(() => listSwapTargetsAction({ fromTableId: table.id })).then((result) => {
      setLoading(false)
      if (result.ok) setTargets(result.data.tables)
      else toast.error(result.error)
    })
  }, [open, table])

  const swap = async () => {
    if (!table || !toId) return
    setBusy(true)
    const result = await callAction(() => swapTableAction({ fromTableId: table.id, toTableId: toId }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      `Table ${result.data.fromNumber} moved to table ${result.data.toNumber}${
        result.data.movedOrders ? ` with ${result.data.movedOrders} order${result.data.movedOrders === 1 ? '' : 's'}` : ''
      }`,
    )
    onOpenChange(false)
    router.refresh()
  }

  return (
    <Dialog open={open && table !== null} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Move table {table?.number}</DialogTitle>
          <DialogDescription>
            The whole sitting moves — every open order, the bill and its payments, the customer.
            Table {table?.number} is empty afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="swap-to">Move to</Label>
          {loading ? (
            <p className="text-sm text-muted-foreground">Looking for empty tables…</p>
          ) : targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No empty table at this location right now.
            </p>
          ) : (
            <ItemPicker
              id="swap-to"
              options={targets.map((t) => ({
                value: t.id,
                label: `Table ${t.number}${t.label ? ` · ${t.label}` : ''}`,
                hint: `${t.area ? `${t.area} · ` : ''}seats ${t.capacity}`,
              }))}
              value={toId}
              onChange={setToId}
              placeholder="Choose an empty table…"
              searchPlaceholder="Search tables…"
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={swap} loading={busy} disabled={!toId}>
            <ArrowRightLeft /> Move sitting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
