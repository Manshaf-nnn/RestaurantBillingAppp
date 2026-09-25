'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { saveDeliveryLocation, setDeliveryLocationActive } from '../location-actions'
import type { LocationRow } from '../locations'

/**
 * The places deliveries go, in the owner's own words.
 *
 * ── Why an editable list and not a map ──────────────────────────────────────
 *
 * On a campus there are perhaps twenty places food is carried to and everybody
 * already calls them the same thing. A typed address box collects twenty
 * spellings of "boys hostel", none of which a rider can sort a bag by; a map
 * needs a geocoder this system does not have and would still land the pin on
 * the wrong side of a building. A list the owner wrote is exact, reads the same
 * on every ticket, and can be reordered as the round changes.
 *
 * ── The three columns that are not obvious ──────────────────────────────────
 *
 * GROUP is a heading in the guest's picker — "Hostels", "Staff Quarters" — so
 * forty options read as three short lists. Optional, and locations with no
 * group keep their place in the owner's own order rather than being swept to
 * the bottom.
 *
 * FOR is the customer category this place is offered to. Empty means everyone.
 * Set, and only guests who picked that category see it, which is how "Girls
 * Hostel" is shown to Campus Student and not to the public out of one list.
 *
 * RIDER NOTE rides on the ticket and never appears in the picker: a gate code
 * or "ask at reception" is for the person carrying the bag, not for the guest
 * choosing from a dropdown.
 */

export interface LocationCategory {
  id: string
  name: string
}

export interface LocationBranch {
  id: string
  name: string
}

export function LocationsManager({
  rows,
  categories,
  branches,
}: {
  rows: LocationRow[]
  categories: LocationCategory[]
  branches: LocationBranch[]
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [draft, setDraft] = React.useState<null | Partial<LocationRow>>(null)

  const save = async (row: Partial<LocationRow>) => {
    if (!row.name?.trim()) {
      toast.error('Give the place a name')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      saveDeliveryLocation({
        id: row.id ?? '',
        name: row.name ?? '',
        groupName: row.groupName ?? '',
        note: row.note ?? '',
        categoryId: row.categoryId ?? '',
        branchId: row.branchId ?? '',
        sortOrder: row.sortOrder ?? rows.length,
        isActive: row.isActive ?? true,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(row.id ? 'Location updated' : 'Location added')
    setDraft(null)
    router.refresh()
  }

  const toggle = async (row: LocationRow) => {
    setBusy(true)
    const result = await callAction(() =>
      setDeliveryLocationActive({ id: row.id, isActive: !row.isActive }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(row.isActive ? `${row.name} retired` : `${row.name} is back`)
    router.refresh()
  }

  return (
    <SectionCard
      title="Delivery locations"
      description="The places a delivery goes. Guests pick from this list instead of typing an address, so every ticket reads the same."
      actions={
        <Button size="sm" onClick={() => setDraft({ isActive: true, sortOrder: rows.length })}>
          <Plus /> Add a place
        </Button>
      }
    >
      {draft ? (
        <LocationForm
          draft={draft}
          categories={categories}
          branches={branches}
          busy={busy}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => save(draft)}
        />
      ) : null}

      {rows.length === 0 && !draft ? (
        <EmptyState
          icon={<MapPin className="size-8" />}
          title="No places yet"
          description="Add the buildings, hostels or blocks you deliver to. Guests will choose from them at checkout."
        />
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li
              key={row.id}
              className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5',
                !row.isActive && 'opacity-55',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {row.name}
                  {row.isActive ? null : (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">retired</span>
                  )}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[
                    row.groupName,
                    row.categoryName ? `for ${row.categoryName}` : null,
                    row.note,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Shown to everyone'}
                </span>
              </span>

              <Button size="sm" variant="ghost" onClick={() => setDraft(row)} disabled={busy}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => toggle(row)}
                disabled={busy}
                aria-label={row.isActive ? `Retire ${row.name}` : `Restore ${row.name}`}
              >
                {row.isActive ? <Trash2 /> : <RotateCcw />}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

function LocationForm({
  draft,
  categories,
  branches,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Partial<LocationRow>
  categories: LocationCategory[]
  branches: LocationBranch[]
  busy: boolean
  onChange: (next: Partial<LocationRow>) => void
  onCancel: () => void
  onSave: () => void
}) {
  const set = <K extends keyof LocationRow>(key: K, value: LocationRow[K]) =>
    onChange({ ...draft, [key]: value })

  return (
    <div className="mb-4 rounded-xl border border-dashed p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required>
          <Input
            value={draft.name ?? ''}
            onChange={(event) => set('name', event.target.value)}
            placeholder="Boys Hostel"
          />
        </Field>

        <Field label="Group" hint="Optional heading in the guest's list.">
          <Input
            value={draft.groupName ?? ''}
            onChange={(event) => set('groupName', event.target.value)}
            placeholder="Hostels"
          />
        </Field>

        <Field label="For" hint="Empty shows it to everyone.">
          <Select
            value={draft.categoryId ?? '__all__'}
            onValueChange={(value: string) => set('categoryId', value === '__all__' ? null : value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Everyone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Everyone</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Location" hint="Empty means every location delivers here.">
          <Select
            value={draft.branchId ?? '__all__'}
            onValueChange={(value: string) => set('branchId', value === '__all__' ? null : value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Every location" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Every location</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Note for the rider"
          className="sm:col-span-2"
          hint="On the ticket only — the guest never sees this."
        >
          <Input
            value={draft.note ?? ''}
            onChange={(event) => set('note', event.target.value)}
            placeholder="Gate code 4417, ask at reception"
          />
        </Field>
      </div>

      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onSave} loading={busy} disabled={busy}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
