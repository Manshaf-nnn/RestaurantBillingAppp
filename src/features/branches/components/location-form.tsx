'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Factory, Plus, Store, Warehouse } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAction } from '@/lib/use-action'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { createLocationAction } from '../actions'
import { ManagerCredentials } from './manager-credentials'

/** Somebody who could be put in charge — already has an account here. */
export interface ManagerCandidate {
  id: string
  name: string
  email: string
  /** Set when they already run somewhere, so the form can say so. */
  branchName: string | null
}

const MANAGER_MODES = [
  { value: 'NONE', label: 'Nobody yet', hint: 'You can name someone later.' },
  { value: 'EXISTING', label: 'Someone who already works here', hint: 'Pick from your team.' },
  { value: 'NEW', label: 'Add a new manager', hint: 'Creates their account and sign-in code.' },
] as const

const TYPES = [
  { value: 'BRANCH', label: 'Branch', icon: Store, hint: 'Serves guests. Has tables, a kitchen and a till.' },
  { value: 'PRODUCTION_HOUSE', label: 'Production house', icon: Factory, hint: 'Makes food from raw materials and sends it out. No guests.' },
  { value: 'CENTRAL_WAREHOUSE', label: 'Central warehouse', icon: Warehouse, hint: 'Receives bulk deliveries and supplies the others.' },
] as const

/**
 * Adding a location.
 *
 * The type is chosen as a card rather than a dropdown because it is the one
 * decision on this form that is hard to change later — a production house and
 * a branch behave differently, and the difference is worth a sentence each
 * rather than three words in a select.
 */
export function LocationForm({
  managers = [],
  canCreateManager = false,
}: {
  /** People who could run it. Empty is fine — the option just hides. */
  managers?: ManagerCandidate[]
  /** Only an owner or admin may mint a manager; the server enforces it too. */
  canCreateManager?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [type, setType] = React.useState<string>('BRANCH')
  const [name, setName] = React.useState('')
  const [code, setCode] = React.useState('')
  const [address, setAddress] = React.useState('')
  const [phone, setPhone] = React.useState('')

  const [managerMode, setManagerMode] = React.useState<'NONE' | 'EXISTING' | 'NEW'>('NONE')
  const [managerId, setManagerId] = React.useState('')
  const [managerName, setManagerName] = React.useState('')
  const [managerEmail, setManagerEmail] = React.useState('')
  const [managerPhone, setManagerPhone] = React.useState('')

  /*
   * Held after a successful save so the code can be handed over.
   *
   * The form stays open showing this rather than closing on success, because
   * the code is shown exactly once here and a form that vanished the moment it
   * appeared would lose it. It is still readable afterwards on the location's
   * own page, but nobody knows that the first time.
   */
  const [issued, setIssued] = React.useState<{
    locationName: string
    name: string
    email: string
    signInCode: string
    emailed: boolean
  } | null>(null)

  const { busy, run } = useAction()

  const reset = () => {
    setName(''); setCode(''); setAddress(''); setPhone('')
    setManagerMode('NONE'); setManagerId('')
    setManagerName(''); setManagerEmail(''); setManagerPhone('')
  }

  const submit = () =>
    run(
      () =>
        createLocationAction({
          name, code, type, address, phone,
          managerMode, managerId, managerName, managerEmail, managerPhone,
        }),
      {
        success: (data) =>
          data.manager ? `${data.name} added · ${data.manager.name} manages it` : `${data.name} added`,
        onDone: (data) => {
          if (data.manager) {
            setIssued({ locationName: data.name, ...data.manager })
          } else {
            setOpen(false)
          }
          reset()
          router.refresh()
        },
      },
    )

  if (issued) {
    return (
      <SectionCard
        title={`${issued.locationName} is ready`}
        description="Give the manager these details. You can print them again later from the location's own page."
      >
        <ManagerCredentials
          name={issued.name}
          email={issued.email}
          signInCode={issued.signInCode}
          emailed={issued.emailed}
          locationName={issued.locationName}
        />
        <div className="mt-4 flex gap-2">
          <Button onClick={() => { setIssued(null); setOpen(false) }}>Done</Button>
          <Button variant="outline" onClick={() => setIssued(null)}>Add another location</Button>
        </div>
      </SectionCard>
    )
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-2 h-4 w-4" />
        Add location
      </Button>
    )
  }

  return (
    <SectionCard
      title="Add a location"
      description="Branches, production houses and warehouses all share one stock ledger — only what they do differs."
    >
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {TYPES.map((t) => {
          const Icon = t.icon
          const active = type === t.value
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setType(t.value)}
              className={`rounded-lg border p-3 text-left transition ${
                active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
              }`}
            >
              <span className="flex items-center gap-2 font-medium">
                <Icon className="h-4 w-4" />
                {t.label}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{t.hint}</span>
            </button>
          )
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="loc-name">Name</Label>
          <Input id="loc-name" placeholder="e.g. Kandy" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="loc-code">Short code</Label>
          <Input id="loc-code" placeholder="e.g. KAN" value={code} onChange={(e) => setCode(e.target.value)} />
          <p className="text-xs text-muted-foreground">Appears on transfers and reports.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="loc-address">Address (optional)</Label>
          <Input id="loc-address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="loc-phone">Phone (optional)</Label>
          <Input id="loc-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>

      {/* ── who runs it ──────────────────────────────────────────── */}
      <div className="mt-5 border-t border-border pt-4">
        <p className="text-sm font-medium">Who manages this location?</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Whoever is named here is confined to this location — they see its stock, its orders and
          its figures, and nobody else&apos;s.
        </p>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {MANAGER_MODES.filter(
            (m) =>
              // "Someone who already works here" is pointless with an empty
              // team, and creating a manager is not everyone's to do.
              (m.value !== 'EXISTING' || managers.length > 0) &&
              (m.value !== 'NEW' || canCreateManager),
          ).map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setManagerMode(m.value)}
              className={`rounded-lg border p-3 text-left transition ${
                managerMode === m.value
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted'
              }`}
            >
              <span className="block text-sm font-medium">{m.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{m.hint}</span>
            </button>
          ))}
        </div>

        {managerMode === 'EXISTING' ? (
          <div className="mt-3 max-w-sm space-y-1.5">
            <Label htmlFor="loc-manager">Manager</Label>
            <select
              id="loc-manager"
              className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
            >
              <option value="">Choose…</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.branchName ? ` — currently at ${m.branchName}` : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Someone who already runs another location keeps it — they are named here but not
              moved.
            </p>
          </div>
        ) : null}

        {managerMode === 'NEW' ? (
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="mgr-name">Manager&apos;s name</Label>
              <Input
                id="mgr-name"
                placeholder="e.g. Sunil Perera"
                value={managerName}
                onChange={(e) => setManagerName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mgr-email">Email</Label>
              <Input
                id="mgr-email"
                type="email"
                placeholder="sunil@example.com"
                value={managerEmail}
                onChange={(e) => setManagerEmail(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">This is what they sign in with.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mgr-phone">Phone (optional)</Label>
              <Input
                id="mgr-phone"
                value={managerPhone}
                onChange={(e) => setManagerPhone(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              A manager account is created and a sign-in code issued. You will see the code once
              here, and it stays on this location&apos;s page afterwards.
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex gap-2">
        <Button onClick={submit} disabled={busy || !name.trim() || !code.trim()}>
          {busy ? 'Adding…' : 'Add location'}
        </Button>
        <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </SectionCard>
  )
}
