'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ItemPicker } from '@/components/ui/item-picker'
import { useAction } from '@/lib/use-action'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { requestTransferAction } from '../actions'

interface Line { key: string; itemId: string; quantity: string }

/**
 * Requesting a transfer.
 *
 * ── Pull, not push (recorrection.md §1) ─────────────────────────────────────
 *
 * The branch that needs stock asks for it. So the destination is the
 * requester's own location — locked, when they have exactly one — and the
 * source is any other location in the business, including ones they cannot
 * otherwise see: a branch asks the warehouse without being able to open the
 * warehouse. The form used to offer both ends freely, which let a branch
 * "request" that its own stock be sent somewhere else; that is a push, and
 * the source's approval step made no sense for it.
 *
 * An owner, who works across every location, may act for any destination
 * and is offered the choice.
 *
 * The item list is driven by what the *source* actually holds — you cannot ask
 * for chicken from a warehouse that has none, and offering it would only turn
 * into an error after the fact. Free stock is shown per item, since "available"
 * minus what is already promised elsewhere is the number that matters.
 */
export function TransferBuilder({
  locations,
  stockByBranch,
  actableBranchIds,
}: {
  locations: Array<{ id: string; name: string; type: string }>
  stockByBranch: Array<{ branchId: string; items: Array<{ itemId: string; name: string; unit: string; free: number }> }>
  /** Branches this person may request FOR. Null = any. */
  actableBranchIds: string[] | null
}) {
  const router = useRouter()

  const destinations = React.useMemo(
    () => (actableBranchIds === null ? locations : locations.filter((l) => actableBranchIds.includes(l.id))),
    [locations, actableBranchIds],
  )
  // One possible destination is not a choice; it is a fact about the person.
  const lockedTo = destinations.length === 1 ? destinations[0] : null

  const [toId, setToId] = React.useState(lockedTo?.id ?? '')
  const [fromId, setFromId] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<Line[]>([])
  const { busy, run } = useAction()

  /*
   * A transfer moves stock between locations (correctionA.md §7): the source
   * list excludes the destination, so a transfer always changes which
   * location holds the stock. The storage-area selects that once let a
   * transfer be a shelf-to-shelf move inside one site are gone.
   */
  const sources = React.useMemo(
    () => locations.filter((l) => l.id !== toId),
    [locations, toId],
  )

  const available = React.useMemo(
    () => stockByBranch.find((s) => s.branchId === fromId)?.items ?? [],
    [stockByBranch, fromId],
  )
  const itemById = React.useMemo(() => new Map(available.map((i) => [i.itemId, i])), [available])

  // Free stock on the second line, because "can they send 20 of these" is the
  // question being asked while the list is open (correctionA.md §8).
  const itemOptions = React.useMemo(
    () =>
      available.map((i) => ({
        value: i.itemId,
        label: i.name,
        hint: `${i.free} ${i.unit.toLowerCase()} free`,
      })),
    [available],
  )

  // Changing the source invalidates any line chosen from the old one.
  React.useEffect(() => { setLines([]) }, [fromId])

  // ...and choosing a destination can strand the source on the same location.
  React.useEffect(() => {
    if (fromId && fromId === toId) setFromId('')
  }, [fromId, toId])

  const toName = locations.find((l) => l.id === toId)?.name
  const fromName = locations.find((l) => l.id === fromId)?.name

  const submit = async () => {
    const payload = lines
      .filter((l) => l.itemId && Number(l.quantity) > 0)
      .map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity) }))

    if (!toId) { toast.error('Choose which location this is for'); return }
    if (!fromId) { toast.error('Choose where it should come from'); return }
    if (fromId === toId) { toast.error('Choose two different locations'); return }
    if (payload.length === 0) { toast.error('Add at least one item'); return }

    const over = payload.find((p) => (itemById.get(p.itemId)?.free ?? 0) < p.quantity)
    if (over) {
      toast.error(`Only ${itemById.get(over.itemId)?.free} of ${itemById.get(over.itemId)?.name} available`)
      return
    }

    await run(
      () => requestTransferAction({
        fromBranchId: fromId, toBranchId: toId, notes, lines: payload,
      }),
      {
        success: (data) => `${data.number} requested`,
        onDone: (data) => router.push(`/dashboard/transfers/${data.id}`),
      },
    )
  }

  if (destinations.length === 0) {
    return (
      <SectionCard title="No location to request for">
        <p className="text-sm text-muted-foreground">
          Your account is not attached to a location, so there is nowhere for a transfer to be
          sent. Ask a manager to set your location and try again.
        </p>
      </SectionCard>
    )
  }

  return (
    <div className="space-y-5">
      <SectionCard title="Where it is going, and where from">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="to">Requesting for</Label>
            {lockedTo ? (
              <div
                id="to"
                data-locked="true"
                className="flex h-10 w-full items-center rounded-lg border border-input bg-muted/40 px-3 text-sm"
              >
                {lockedTo.name} · {lockedTo.type.replace(/_/g, ' ').toLowerCase()}
              </div>
            ) : (
              <select
                id="to"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                value={toId}
                onChange={(e) => setToId(e.target.value)}
              >
                <option value="">Choose…</option>
                {destinations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} · {l.type.replace(/_/g, ' ').toLowerCase()}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="from">Send from</Label>
            <select
              id="from"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
              disabled={!toId}
            >
              <option value="">{toId ? 'Choose…' : 'Choose the destination first'}</option>
              {sources.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.type.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
        </div>
        {toName && fromName ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {fromName} approves and sends it; {toName} receives it.
          </p>
        ) : null}
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
                      <ItemPicker
                        options={itemOptions}
                        value={line.itemId}
                        onChange={(next) => setLines((c) => c.map((l) => l.key === line.key ? { ...l, itemId: next } : l))}
                        searchPlaceholder="Search items…"
                        emptyMessage="No item there matches that."
                      />
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
        <Textarea rows={2} placeholder="Anything the sending location should know" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </SectionCard>

      <Button size="lg" onClick={submit} disabled={busy}>
        <Send className="mr-2 h-4 w-4" />
        {busy ? 'Requesting…' : 'Request transfer'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Requesting moves no stock. {fromName ?? 'The source'} approves it on the Approvals desk and dispatches it; it reaches {toName ?? 'you'} when received.
      </p>
    </div>
  )
}
