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
export function LocationForm() {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [type, setType] = React.useState<string>('BRANCH')
  const [name, setName] = React.useState('')
  const [code, setCode] = React.useState('')
  const [address, setAddress] = React.useState('')
  const [phone, setPhone] = React.useState('')
  const { busy, run } = useAction()

  const submit = () =>
    run(() => createLocationAction({ name, code, type, address, phone }), {
      success: (data) => `${data.name} added`,
      onDone: () => {
        setName(''); setCode(''); setAddress(''); setPhone(''); setOpen(false)
        router.refresh()
      },
    })

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

      <div className="mt-4 flex gap-2">
        <Button onClick={submit} disabled={busy || !name.trim() || !code.trim()}>
          {busy ? 'Adding…' : 'Add location'}
        </Button>
        <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </SectionCard>
  )
}
