'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { saveDeliveryLocation, setDeliveryLocationActive } from '../location-actions'
import type { LocationRow } from '../locations'

/**
 * The places a delivery goes, two levels deep, edited where the code that
 * asks for them is edited.
 *
 * ── The owner's model, and why the screen mirrors it ────────────────────────
 *
 * "First create a main location — University — and under it the sub-locations:
 * hostels, villas." So the screen is a list of main places, each with its own
 * places under it and an "add a place under University" right there. Not a
 * flat list with a heading typed on every row, which is what this replaced and
 * which asked the owner to spell "University" the same way fourteen times.
 *
 * ── No branch picker ────────────────────────────────────────────────────────
 *
 * A place belongs to the code it is edited under, and a code belongs to one
 * branch. Asking which branch a hostel is in, on the screen for the University
 * code, is a question with one answer, so it is not asked.
 */

export function LocationsManager({
  rows,
  branchId,
}: {
  rows: LocationRow[]
  /** The code's own branch — every place made here lands on it. */
  branchId: string
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  /** Which form is open: a new main place, a new sub-place under X, or an edit. */
  const [form, setForm] = React.useState<
    | { kind: 'main' }
    | { kind: 'sub'; parentId: string; parentName: string }
    | { kind: 'edit'; row: LocationRow }
    | null
  >(null)

  const mains = rows.filter((row) => row.parentId === null)
  const under = (parentId: string) => rows.filter((row) => row.parentId === parentId)

  const save = async (values: { name: string; note: string }) => {
    if (!values.name.trim()) return toast.error('Give the place a name')
    setBusy(true)
    const result = await callAction(() =>
      saveDeliveryLocation({
        id: form?.kind === 'edit' ? form.row.id : '',
        name: values.name,
        note: values.note,
        parentId:
          form?.kind === 'sub' ? form.parentId : form?.kind === 'edit' ? (form.row.parentId ?? '') : '',
        branchId,
        sortOrder:
          form?.kind === 'edit'
            ? form.row.sortOrder
            : form?.kind === 'sub'
              ? under(form.parentId).length
              : mains.length,
        isActive: form?.kind === 'edit' ? form.row.isActive : true,
      }),
    )
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    toast.success(form?.kind === 'edit' ? 'Place updated' : 'Place added')
    setForm(null)
    router.refresh()
  }

  const toggle = async (row: LocationRow) => {
    setBusy(true)
    const result = await callAction(() =>
      setDeliveryLocationActive({ id: row.id, isActive: !row.isActive }),
    )
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    toast.success(row.isActive ? `${row.name} retired` : `${row.name} is back`)
    router.refresh()
  }

  return (
    <div className="space-y-3 rounded-xl border p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">Delivery places</p>
          <p className="text-xs text-muted-foreground">
            A main place, then the places inside it. Guests pick one at checkout.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setForm({ kind: 'main' })} disabled={busy}>
          <Plus /> Add a main place
        </Button>
      </div>

      {form?.kind === 'main' ? (
        <PlaceForm
          title="New main place"
          hint="Somewhere with places inside it — a campus, an estate, a town."
          placeholder="University"
          busy={busy}
          onCancel={() => setForm(null)}
          onSave={save}
        />
      ) : null}

      {mains.length === 0 && form === null ? (
        <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <MapPin className="size-4" /> No places yet. Start with the main one.
        </p>
      ) : null}

      <ul className="space-y-2">
        {mains.map((main) => {
          const subs = under(main.id)
          return (
            <li
              key={main.id}
              className={cn('rounded-lg border bg-card', !main.isActive && 'opacity-55')}
            >
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {main.name}
                    {main.isActive ? null : (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">retired</span>
                    )}
                  </span>
                  {main.note ? (
                    <span className="block truncate text-xs text-muted-foreground">{main.note}</span>
                  ) : null}
                </span>
                {main.isActive ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setForm({ kind: 'sub', parentId: main.id, parentName: main.name })}
                  >
                    <Plus /> Add under {main.name}
                  </Button>
                ) : null}
                <RowActions row={main} busy={busy} onEdit={() => setForm({ kind: 'edit', row: main })} onToggle={() => toggle(main)} />
              </div>

              {form?.kind === 'sub' && form.parentId === main.id ? (
                <div className="border-t px-3 py-2">
                  <PlaceForm
                    title={`New place under ${main.name}`}
                    hint="What the guest picks. A gate code or landmark for the rider goes in the note."
                    placeholder="Boys Hostel"
                    busy={busy}
                    onCancel={() => setForm(null)}
                    onSave={save}
                  />
                </div>
              ) : null}

              {subs.length > 0 ? (
                <ul className="divide-y border-t">
                  {subs.map((sub) => (
                    <li
                      key={sub.id}
                      className={cn('flex flex-wrap items-center gap-2 py-1.5 pl-7 pr-3', !sub.isActive && 'opacity-55')}
                    >
                      {form?.kind === 'edit' && form.row.id === sub.id ? (
                        <div className="w-full">
                          <PlaceForm
                            title={`Edit ${sub.name}`}
                            initial={{ name: sub.name, note: sub.note ?? '' }}
                            placeholder="Boys Hostel"
                            busy={busy}
                            onCancel={() => setForm(null)}
                            onSave={save}
                          />
                        </div>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">
                              {sub.name}
                              {sub.isActive ? null : (
                                <span className="ml-2 text-xs text-muted-foreground">retired</span>
                              )}
                            </span>
                            {sub.note ? (
                              <span className="block truncate text-xs text-muted-foreground">{sub.note}</span>
                            ) : null}
                          </span>
                          <RowActions row={sub} busy={busy} onEdit={() => setForm({ kind: 'edit', row: sub })} onToggle={() => toggle(sub)} />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}

              {form?.kind === 'edit' && form.row.id === main.id ? (
                <div className="border-t px-3 py-2">
                  <PlaceForm
                    title={`Edit ${main.name}`}
                    initial={{ name: main.name, note: main.note ?? '' }}
                    placeholder="University"
                    busy={busy}
                    onCancel={() => setForm(null)}
                    onSave={save}
                  />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function RowActions({
  row,
  busy,
  onEdit,
  onToggle,
}: {
  row: LocationRow
  busy: boolean
  onEdit: () => void
  onToggle: () => void
}) {
  return (
    <span className="flex shrink-0 items-center">
      <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}>
        Edit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onToggle}
        disabled={busy}
        aria-label={row.isActive ? `Retire ${row.name}` : `Restore ${row.name}`}
      >
        {row.isActive ? <Trash2 /> : <RotateCcw />}
      </Button>
    </span>
  )
}

function PlaceForm({
  title,
  hint,
  placeholder,
  initial,
  busy,
  onCancel,
  onSave,
}: {
  title: string
  hint?: string
  placeholder: string
  initial?: { name: string; note: string }
  busy: boolean
  onCancel: () => void
  onSave: (values: { name: string; note: string }) => void
}) {
  const [name, setName] = React.useState(initial?.name ?? '')
  const [note, setNote] = React.useState(initial?.note ?? '')

  return (
    <div className="rounded-lg border border-dashed p-3">
      <p className="mb-2 text-xs font-semibold">{title}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name" required hint={hint}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} autoFocus />
        </Field>
        <Field label="Note for the rider" hint="Never shown to the guest.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Gate code 4417" />
        </Field>
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => onSave({ name, note })} loading={busy} disabled={busy}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
