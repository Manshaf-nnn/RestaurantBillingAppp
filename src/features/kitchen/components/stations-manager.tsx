'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, ChefHat, Pencil, Plus, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import {
  assignAllDishesAction,
  deleteStationAction,
  saveStationAction,
  setStationActiveAction,
} from '../actions'

export interface StationView {
  id: string
  name: string
  description: string | null
  printerName: string | null
  sortOrder: number
  isActive: boolean
  dishCount: number
  staff: Array<{ id: string; name: string; staffCode: string | null }>
}

/**
 * Setting up a kitchen's sections.
 *
 * ── The switch-on cliff, and the three things that stop it ──────────────────
 *
 * The moment a restaurant creates its first section, every dish on the menu is
 * unmapped — and an unmapped dish stops the kitchen accepting the order it is
 * on. Three affordances exist purely to keep that from being a wall:
 *
 *   1. creating the first section offers to send the whole menu to it,
 *   2. a standing banner lists what is still unmapped, with a one-tap fix,
 *   3. the kitchen queue badges an unmapped dish on the ticket itself, so it is
 *      found while somebody is reading a menu rather than by a button failing
 *      at eight o'clock on a Friday.
 *
 * Without those the feature is unusable on the day it is turned on.
 */
export function StationsManager({
  branchId,
  branchName,
  canManage,
  stations,
  unmapped,
  staffOptions,
}: {
  branchId: string
  branchName: string
  canManage: boolean
  stations: StationView[]
  unmapped: Array<{ foodId: string; name: string }>
  staffOptions: Array<{ id: string; name: string; staffCode: string | null; role: string }>
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  const [editing, setEditing] = React.useState<string | null>(null)
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [printerName, setPrinterName] = React.useState('')
  const [staffIds, setStaffIds] = React.useState<string[]>([])
  const [open, setOpen] = React.useState(false)

  const active = stations.filter((s) => s.isActive)

  const reset = () => {
    setEditing(null)
    setName('')
    setDescription('')
    setPrinterName('')
    setStaffIds([])
    setOpen(false)
  }

  const load = (station: StationView) => {
    setEditing(station.id)
    setName(station.name)
    setDescription(station.description ?? '')
    setPrinterName(station.printerName ?? '')
    setStaffIds(station.staff.map((s) => s.id))
    setOpen(true)
  }

  const save = async () => {
    if (name.trim().length < 2) {
      toast.error('Give the section a name')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      saveStationAction({
        stationId: editing ?? undefined,
        branchId,
        name,
        description,
        printerName,
        staffIds,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }

    /*
     * The first section is the moment every dish becomes unmapped. Offer the
     * shortcut immediately rather than leaving the owner to discover the
     * problem when the kitchen cannot accept an order.
     */
    const isFirst = !editing && stations.length === 0
    toast.success(editing ? 'Section updated' : 'Section created')
    if (isFirst && unmapped.length > 0) {
      await assignAll(result.data.id, `Sent all ${unmapped.length} dishes to ${name.trim()}`)
    }
    reset()
    router.refresh()
  }

  const assignAll = async (stationId: string, message?: string) => {
    setBusy(true)
    const result = await callAction(() =>
      assignAllDishesAction({ stationId, onlyUnassigned: true }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(message ?? `${result.data.count} dishes assigned`)
    router.refresh()
  }

  const retire = async (station: StationView) => {
    setBusy(true)
    const result = await callAction(() =>
      setStationActiveAction({ stationId: station.id, isActive: !station.isActive }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(station.isActive ? 'Section retired' : 'Section back in use')
    router.refresh()
  }

  const remove = async (station: StationView) => {
    setBusy(true)
    const result = await callAction(() => deleteStationAction({ stationId: station.id }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Section removed')
    router.refresh()
  }

  const toggleStaff = (userId: string) =>
    setStaffIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    )

  return (
    <div className="space-y-5">
      {unmapped.length > 0 && active.length > 0 ? (
        <div className="rounded-xl border border-warning/50 bg-warning/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {unmapped.length} dish{unmapped.length === 1 ? '' : 'es'} have no section
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                The kitchen cannot accept an order containing{' '}
                {unmapped.length === 1 ? 'it' : 'any of them'} until you say who cooks{' '}
                {unmapped.length === 1 ? 'it' : 'them'}.
              </p>
              <p className="mt-2 text-sm">
                {unmapped.slice(0, 8).map((dish) => dish.name).join(' · ')}
                {unmapped.length > 8 ? ` · and ${unmapped.length - 8} more` : ''}
              </p>
              {canManage ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {active.map((station) => (
                    <Button
                      key={station.id}
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => assignAll(station.id)}
                    >
                      Send them all to {station.name}
                    </Button>
                  ))}
                  <Button size="sm" variant="ghost" asChild>
                    <Link href="/dashboard/menu">Assign them one by one</Link>
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <SectionCard
        title="Sections"
        description={`How ${branchName}'s kitchen is divided. Orders are split across these automatically once the kitchen accepts them.`}
        actions={
          canManage && !open ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              New section
            </Button>
          ) : null
        }
      >
        {stations.length === 0 && !open ? (
          <div className="py-8 text-center">
            <ChefHat className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No sections yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Until you add one, the kitchen works exactly as it does today — one rail, whole
              orders. Add sections when you want each part of the kitchen to see only its own
              dishes.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {stations.map((station) => (
              <li key={station.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <span className="font-medium">{station.name}</span>
                {!station.isActive ? <Badge variant="secondary">Retired</Badge> : null}
                <span className="text-sm text-muted-foreground">
                  {station.dishCount} dish{station.dishCount === 1 ? '' : 'es'}
                  {station.staff.length > 0
                    ? ` · ${station.staff.map((s) => s.name).join(', ')}`
                    : ' · anyone in the kitchen'}
                  {station.printerName ? ` · prints to ${station.printerName}` : ''}
                </span>
                {station.description ? (
                  <span className="w-full text-xs text-muted-foreground">{station.description}</span>
                ) : null}
                {canManage ? (
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => load(station)}>
                      <Pencil className="mr-1.5 size-4" />
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => retire(station)}>
                      {station.isActive ? 'Retire' : 'Restore'}
                    </Button>
                    {station.dishCount === 0 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => remove(station)}
                        aria-label={`Remove ${station.name}`}
                      >
                        <Trash2 className="size-4 text-muted-foreground" />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {canManage && open ? (
        <SectionCard
          title={editing ? 'Edit section' : 'New section'}
          description="Name it whatever the kitchen calls it — Rice, Kottu, Juice Bar, Grill."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="st-name">Name</Label>
              <Input
                id="st-name"
                placeholder="e.g. Rice &amp; Curry"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-desc">Description (optional)</Label>
              <Input
                id="st-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-printer">Printer (optional)</Label>
              <Input
                id="st-printer"
                placeholder="Ticket printer name"
                value={printerName}
                onChange={(e) => setPrinterName(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <Users className="size-4 text-muted-foreground" />
              Who works this section
            </p>
            {/*
              Leaving everyone unticked is a real choice, not an oversight: a
              cook with no section assigned anywhere sees every section at their
              branch, which is what a small kitchen wants.
            */}
            <p className="mb-2 text-xs text-muted-foreground">
              Leave everyone unticked and any cook at {branchName} can work it.
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {staffOptions.map((person) => (
                <label
                  key={person.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <Checkbox
                    checked={staffIds.includes(person.id)}
                    onCheckedChange={() => toggleStaff(person.id)}
                  />
                  <span className="min-w-0 truncate">
                    {person.name}
                    {person.staffCode ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {person.staffCode}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <Button onClick={save} disabled={busy}>
              {editing ? 'Save changes' : 'Create section'}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              <X className="mr-1.5 size-4" />
              Cancel
            </Button>
          </div>
        </SectionCard>
      ) : null}
    </div>
  )
}
