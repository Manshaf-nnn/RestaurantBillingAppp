'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { createStorageLocationAction } from '../actions'

/** Storage areas within a location — cold room, dry store, bar. */
export function StorageForm({
  branchId,
  existing,
}: {
  branchId: string
  existing: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const [name, setName] = React.useState('')
  const [code, setCode] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    setBusy(true)
    const result = await createStorageLocationAction({ branchId, name, code })
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(`${name} added`)
    setName(''); setCode('')
    router.refresh()
  }

  return (
    <SectionCard
      title="Storage areas"
      description="Where stock physically sits inside this location. Optional — a small site can keep everything in one place."
    >
      {existing.length > 0 && (
        <ul className="mb-4 flex flex-wrap gap-2">
          {existing.map((s) => (
            <li key={s.id} className="rounded-lg border border-border px-3 py-1.5 text-sm">{s.name}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="st-name" className="text-xs">Name</Label>
          <Input id="st-name" placeholder="e.g. Cold room" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="st-code" className="text-xs">Code</Label>
          <Input id="st-code" className="w-28" placeholder="COLD" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <Button variant="outline" onClick={submit} disabled={busy || !name.trim() || !code.trim()}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add
        </Button>
      </div>
    </SectionCard>
  )
}
