'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAction } from '@/lib/use-action'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { requestTransferAction } from '../actions'

interface Line { key: string; itemId: string; quantity: string }

/**
 * Requesting a transfer.
 *
 * The item list is driven by what the *source* actually holds — you cannot ask
 * for chicken from a warehouse that has none, and offering it would only turn
 * into an error after the fact. Free stock is shown per item, since "available"
 * minus what is already promised elsewhere is the number that matters.
 */
export function TransferBuilder({
  locations,
  stockByBranch,
  storageByBranch = [],
}: {
  locations: Array<{ id: string; name: string; type: string }>
  stockByBranch: Array<{ branchId: string; items: Array<{ itemId: string; name: string; unit: string; free: number }> }>
  storageByBranch?: Array<{ branchId: string; shelves: Array<{ id: string; name: string }> }>
}) {
  const router = useRouter()
  const [fromId, setFromId] = React.useState('')
  const [toId, setToId] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [fromStorageId, setFromStorageId] = React.useState('')
  const [toStorageId, setToStorageId] = React.useState('')
  const [lines, setLines] = React.useState<Line[]>([])
  const { busy, run } = useAction()

  const available = React.useMemo(
    () => stockByBranch.find((s) => s.branchId === fromId)?.items ?? [],
    [stockByBranch, fromId],
  )
  const itemById = React.useMemo(() => new Map(available.map((i) => [i.itemId, i])), [available])

  const shelvesFor = React.useCallback(
    (branchId: string) => storageByBranch.find((s) => s.branchId === branchId)?.shelves ?? [],
    [storageByBranch],
  )
  const fromShelves = shelvesFor(fromId)
  const toShelves = shelvesFor(toId)
  // Moving within one location is only meaningful between two different shelves.
  const sameBranch = Boolean(fromId) && fromId === toId

  // Changing the source invalidates any line chosen from the old one.
  React.useEffect(() => { setLines([]) }, [fromId])

  const submit = async () => {
    const payload = lines
      .filter((l) => l.itemId && Number(l.quantity) > 0)
      .map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity) }))

    if (!fromId || !toId) { toast.error('Choose both locations'); return }
    if (sameBranch && (!fromStorageId || !toStorageId || fromStorageId === toStorageId)) {
      toast.error('Moving within one location needs two different storage areas')
      return
    }
    if (payload.length === 0) { toast.error('Add at least one item'); return }

    const over = payload.find((p) => (itemById.get(p.itemId)?.free ?? 0) < p.quantity)
    if (over) {
      toast.error(`Only ${itemById.get(over.itemId)?.free} of ${itemById.get(over.itemId)?.name} available`)
      return
    }

    await run(
      () => requestTransferAction({
        fromBranchId: fromId, toBranchId: toId, notes, lines: payload,
        fromStorageId, toStorageId,
      }),
      {
        success: (data) => `${data.number} requested`,
        onDone: (data) => router.push(`/dashboard/transfers/${data.id}`),
      },
    )
  }

  return (
    <div className="space-y-5">
      <SectionCard title="From and to">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="from">Send from</Label>
            <select
              id="from"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
            >
              <option value="">Choose…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.type.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to">Send to</Label>
            <select
              id="to"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={toId}
              onChange={(e) => setToId(e.target.value)}
            >
              <option value="">Choose…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.type.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/*
          Only shown when the location has shelves. A restaurant that keeps
          everything in one place should not have to answer a question that has
          one possible answer.
        */}
        {(fromShelves.length > 0 || toShelves.length > 0) && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="from-shelf">
                From storage area {sameBranch ? '' : '(optional)'}
              </Label>
              <select
                id="from-shelf"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                value={fromStorageId}
                onChange={(e) => setFromStorageId(e.target.value)}
                disabled={fromShelves.length === 0}
              >
                <option value="">{fromShelves.length ? 'Anywhere in this location' : 'None set up'}</option>
                {fromShelves.map((sh) => (
                  <option key={sh.id} value={sh.id}>{sh.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to-shelf">
                To storage area {sameBranch ? '' : '(optional)'}
              </Label>
              <select
                id="to-shelf"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                value={toStorageId}
                onChange={(e) => setToStorageId(e.target.value)}
                disabled={toShelves.length === 0}
              >
                <option value="">{toShelves.length ? 'Anywhere in this location' : 'None set up'}</option>
                {toShelves.map((sh) => (
                  <option key={sh.id} value={sh.id}>{sh.name}</option>
                ))}
              </select>
            </div>
            {sameBranch && (
              <p className="sm:col-span-2 text-xs text-muted-foreground">
                Same location on both sides — this moves stock between two storage areas, so the
                location&apos;s total is unchanged. Choose a different area for each.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Items"
        description={fromId ? 'Only what that location actually holds can be sent.' : 'Choose where it is coming from first.'}
      >
        {!fromId ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Pick a source location.</p>
        ) : available.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">That location holds nothing to send.</p>
        ) : (
          <>
            <ul className="space-y-2">
              {lines.map((line) => {
                const item = itemById.get(line.itemId)
                return (
                  <li key={line.key} className="grid grid-cols-12 items-end gap-2">
                    <div className="col-span-12 space-y-1 sm:col-span-6">
                      <Label className="text-xs">Item</Label>
                      <select
                        className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                        value={line.itemId}
                        onChange={(e) => setLines((c) => c.map((l) => l.key === line.key ? { ...l, itemId: e.target.value } : l))}
                      >
                        <option value="">Choose…</option>
                        {available.map((i) => (
                          <option key={i.itemId} value={i.itemId}>{i.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-8 space-y-1 sm:col-span-4">
                      <Label className="text-xs">Quantity {item ? `(${item.free} ${item.unit.toLowerCase()} free)` : ''}</Label>
                      <Input
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(e) => setLines((c) => c.map((l) => l.key === line.key ? { ...l, quantity: e.target.value } : l))}
                      />
                    </div>
                    <button
                      type="button"
                      aria-label="Remove"
                      onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                      className="col-span-4 flex h-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted sm:col-span-2"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                )
              })}
            </ul>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setLines((c) => [...c, { key: `${Date.now()}-${c.length}`, itemId: '', quantity: '' }])}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add item
            </Button>
          </>
        )}
      </SectionCard>

      <SectionCard title="Notes">
        <Textarea rows={2} placeholder="Anything the other end should know" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </SectionCard>

      <Button size="lg" onClick={submit} disabled={busy}>
        <Send className="mr-2 h-4 w-4" />
        {busy ? 'Requesting…' : 'Request transfer'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Requesting moves no stock. It is approved, then dispatched, and only reaches the destination when received.
      </p>
    </div>
  )
}
