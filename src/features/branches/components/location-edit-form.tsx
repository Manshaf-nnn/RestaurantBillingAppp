'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Star, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { Switch } from '@/components/ui/primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SectionCard } from '@/features/dashboard/components/page-header'
import {
  DAY_KEYS,
  DAY_LABELS,
  DEFAULT_HOURS,
  type DayKey,
  type OpeningHours,
} from '@/lib/opening-hours'
import { useAction } from '@/lib/use-action'
import {
  locationRemovalBlockersAction,
  removeLocationAction,
  setDefaultLocationAction,
  updateLocationAction,
} from '../actions'
import type { RemovalBlocker } from '../service'

const TYPES = [
  { value: 'BRANCH', label: 'Branch' },
  { value: 'PRODUCTION_HOUSE', label: 'Production house' },
  { value: 'CENTRAL_WAREHOUSE', label: 'Central warehouse' },
] as const

/*
 * Radix's Select reserves the empty string for "nothing chosen", so "nobody" as
 * a manager needs a value of its own that is converted back on the way out.
 */
const NO_MANAGER = '__none__'

export interface EditableLocation {
  id: string
  name: string
  code: string
  type: string
  address: string | null
  phone: string | null
  isActive: boolean
  isDefault: boolean
  managerId: string | null
  /** null means this location keeps the restaurant's own hours. */
  openingHours: OpeningHours | null
}

export interface ManagerCandidate {
  id: string
  name: string
  roleLabel: string
}

/**
 * Editing a location.
 *
 * `updateLocationAction` and `setDefaultLocationAction` both existed with no
 * caller anywhere, which made a location create-only: once made, nothing could
 * rename it, correct its address, retire it or move the default off it. A typo
 * in a branch name was permanent.
 *
 * The short code is shown but not editable — it is printed on transfers and
 * reports already out in the world, so changing it would rewrite what those
 * documents refer to.
 */
export function LocationEditForm({
  location,
  managers,
}: {
  location: EditableLocation
  managers: ManagerCandidate[]
}) {
  const router = useRouter()
  const [name, setName] = React.useState(location.name)
  const [type, setType] = React.useState(location.type)
  const [address, setAddress] = React.useState(location.address ?? '')
  const [phone, setPhone] = React.useState(location.phone ?? '')
  const [isActive, setIsActive] = React.useState(location.isActive)
  const [managerId, setManagerId] = React.useState(location.managerId ?? NO_MANAGER)
  const [ownHours, setOwnHours] = React.useState(location.openingHours !== null)
  const [hours, setHours] = React.useState<OpeningHours>(location.openingHours ?? DEFAULT_HOURS)

  // Two separate action hooks: saving and promoting to default are independent
  // buttons, and one shared busy flag would disable the wrong one.
  const { busy: saving, run: runSave } = useAction()
  const { busy: promoting, run: runPromote } = useAction()

  const setDay = (day: DayKey, patch: Partial<{ open: string; close: string; closed: boolean }>) =>
    setHours((current) => ({
      ...current,
      [day]: { ...(current[day] ?? { open: '09:00', close: '22:00' }), ...patch },
    }))

  const save = () =>
    runSave(
      () =>
        updateLocationAction({
          branchId: location.id,
          name,
          type,
          address,
          phone,
          isActive,
          managerId: managerId === NO_MANAGER ? null : managerId,
          openingHours: ownHours ? hours : null,
        }),
      {
        success: 'Location updated',
        onDone: () => router.refresh(),
      },
    )

  const makeDefault = () =>
    runPromote(() => setDefaultLocationAction(location.id), {
      success: `${name} is now the default location`,
      onDone: () => router.refresh(),
    })

  return (
    <SectionCard
      title="Location details"
      description="What this place is called, who runs it and when it is open."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="edit-name" required>
          <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Short code"
          htmlFor="edit-code"
          hint="Fixed — it is already printed on transfers and reports."
        >
          <Input id="edit-code" value={location.code} readOnly disabled />
        </Field>
        <Field label="Type">
          <Select value={type} onValueChange={setType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Manager"
          hint="Whoever is named here is also moved to this location, unless they already run another one."
        >
          <Select value={managerId} onValueChange={setManagerId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_MANAGER}>Nobody yet</SelectItem>
              {managers.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name} · {m.roleLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Address" htmlFor="edit-address">
          <Input id="edit-address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="Phone" htmlFor="edit-phone">
          <Input id="edit-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch checked={ownHours} onCheckedChange={setOwnHours} />
          This location has its own opening hours
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          Off means it follows the restaurant&apos;s hours, which is right for most sites and for
          any warehouse that never serves guests.
        </p>

        {ownHours && (
          <div className="mt-3 space-y-2">
            {DAY_KEYS.map((day) => {
              const entry = hours[day]
              const closed = Boolean(entry?.closed)
              return (
                <div key={day} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="w-24 shrink-0">{DAY_LABELS[day]}</span>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch
                      checked={!closed}
                      onCheckedChange={(open) => setDay(day, { closed: !open })}
                      aria-label={`${DAY_LABELS[day]} open`}
                    />
                    {closed ? 'Closed' : 'Open'}
                  </label>
                  {!closed && (
                    <>
                      <Input
                        type="time"
                        className="w-32"
                        value={entry?.open ?? '09:00'}
                        onChange={(e) => setDay(day, { open: e.target.value })}
                        aria-label={`${DAY_LABELS[day]} opens`}
                      />
                      <span className="text-muted-foreground">to</span>
                      <Input
                        type="time"
                        className="w-32"
                        value={entry?.close ?? '22:00'}
                        onChange={(e) => setDay(day, { close: e.target.value })}
                        aria-label={`${DAY_LABELS[day]} closes`}
                      />
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch
            checked={isActive}
            onCheckedChange={setIsActive}
            disabled={location.isDefault}
          />
          In use
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          {location.isDefault
            ? 'The default location cannot be switched off — it is where anything without a location of its own is counted. Make another location the default first.'
            : 'Switching a location off keeps its history and its stock, but hides it from transfers, new orders and the location switcher.'}
        </p>
      </div>

      <RemoveLocation location={location} />

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {location.isDefault ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Star className="h-3.5 w-3.5" />
            This is the default location
          </span>
        ) : (
          <Button variant="outline" onClick={makeDefault} disabled={promoting}>
            <Star className="mr-1.5 h-4 w-4" />
            {promoting ? 'Setting…' : 'Make this the default location'}
          </Button>
        )}
      </div>
    </SectionCard>
  )
}

/**
 * Removing a location, and refusing to when it would lose something.
 *
 * Deliberately two steps rather than a confirm dialog. The first press asks the
 * server what is in the way and shows the answer — "3 items still hold stock
 * here", with what to do about it — so the common outcome is not "are you
 * sure?" but a list of work to finish first. Only a location with nothing left
 * standing gets the second button.
 *
 * The removal is soft. Every order taken here, every movement and every closed
 * drawer stays readable; the location simply leaves the lists. A hard delete is
 * not on offer at all, and the foreign keys are RESTRICT so that it cannot
 * happen by accident either.
 */
function RemoveLocation({ location }: { location: EditableLocation }) {
  const router = useRouter()
  const [blockers, setBlockers] = React.useState<RemovalBlocker[] | null>(null)
  const { run: check, busy: checking } = useAction()
  const { run: remove, busy: removing } = useAction()

  const look = () =>
    check(() => locationRemovalBlockersAction(location.id), {
      onDone: (result) => setBlockers(result.blockers),
    })

  const confirm = () =>
    remove(() => removeLocationAction(location.id), {
      success: 'Location removed.',
      onDone: () => router.push('/dashboard/locations'),
    })

  return (
    <div className="mt-5 border-t border-border pt-4">
      {blockers === null ? (
        <Button variant="outline" onClick={look} disabled={checking}>
          <Trash2 className="mr-1.5 h-4 w-4" />
          {checking ? 'Checking…' : 'Remove this location'}
        </Button>
      ) : blockers.length > 0 ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            This location cannot be removed yet
          </p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {blockers.map((b) => (
              <li key={b.what}>
                <span className="font-medium">{b.what}</span>
                <span className="block text-xs text-muted-foreground">{b.fix}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            You can switch it off instead — that hides it from transfers, new orders and the
            location switcher while keeping everything it holds.
          </p>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setBlockers(null)}>
            Close
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium">Nothing is left at this location.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Removing it takes it off every list and picker. Its past orders, stock movements and
            closed drawers stay in your reports.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="destructive" size="sm" onClick={confirm} disabled={removing}>
              {removing ? 'Removing…' : `Remove ${location.name}`}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setBlockers(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
