'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, Pencil, Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAction } from '@/lib/use-action'
import { SectionCard } from '@/features/dashboard/components/page-header'
import {
  createStorageLocationAction,
  removeStorageLocationAction,
  updateStorageLocationAction,
} from '../actions'

/** Storage areas within a location — cold room, dry store, bar. */
export function StorageForm({
  branchId,
  existing,
}: {
  branchId: string
  existing: Array<{ id: string; name: string; code: string; isDefault: boolean }>
}) {
  const router = useRouter()
  const [name, setName] = React.useState('')
  const [code, setCode] = React.useState('')
  const { busy, run } = useAction()

  const submit = () =>
    run(() => createStorageLocationAction({ branchId, name, code }), {
      success: `${name} added`,
      onDone: () => {
        setName(''); setCode('')
        router.refresh()
      },
    })

  return (
    <SectionCard
      title="Storage areas (shelves, not stock)"
      description="Name the places inside this location where stock sits — Cold room, Dry store, Bar. This does not add any stock; use “Add stock here” above for that."
    >
      {existing.length > 0 && (
        <ul className="mb-4 space-y-1.5">
          {existing.map((s) => (
            <Shelf key={s.id} shelf={s} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="st-name" className="text-xs">Name</Label>
          <Input id="st-name" placeholder="e.g. Cold room, Dry store" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="st-code" className="text-xs">Code</Label>
          <Input id="st-code" className="w-28" placeholder="COLD" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <Button variant="outline" onClick={submit} disabled={busy || !name.trim() || !code.trim()}>
          <Plus className="mr-1.5 h-4 w-4" />
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </SectionCard>
  )
}

/**
 * One shelf, renameable and removable.
 *
 * These were write-once: a storage area could be created and then never
 * renamed, deactivated or removed, so a typo was permanent and a shelf that had
 * been torn out stayed in every picker for good.
 *
 * Removing is refused while the shelf still holds stock — the server checks,
 * and says how much — because a balance recorded against a deleted shelf is a
 * balance recorded nowhere.
 */
function Shelf({ shelf }: { shelf: { id: string; name: string; code: string; isDefault: boolean } }) {
  const router = useRouter()
  const [editing, setEditing] = React.useState(false)
  const [name, setName] = React.useState(shelf.name)
  const { busy, run } = useAction()

  const save = () =>
    run(() => updateStorageLocationAction({ storageLocationId: shelf.id, name }), {
      success: 'Renamed.',
      onDone: () => { setEditing(false); router.refresh() },
    })

  const remove = () =>
    run(() => removeStorageLocationAction(shelf.id), {
      success: `${shelf.name} removed`,
      onDone: () => router.refresh(),
    })

  if (editing) {
    return (
      <li className="flex items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" />
        <Button size="sm" onClick={save} disabled={busy || !name.trim()}>
          <Check className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setName(shelf.name); setEditing(false) }}>
          <X className="h-4 w-4" />
        </Button>
      </li>
    )
  }

  return (
    <li className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm">
      <span className="flex-1">{shelf.name}</span>
      <span className="text-xs text-muted-foreground">{shelf.code}</span>
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)} title={`Rename ${shelf.name}`}>
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      {!shelf.isDefault && (
        <Button
          size="sm"
          variant="ghost"
          onClick={remove}
          disabled={busy}
          title={`Remove ${shelf.name}`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </li>
  )
}
