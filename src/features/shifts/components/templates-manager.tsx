'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox, Switch } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { ROLE_LABELS } from '@/lib/rbac'
import { callAction } from '@/lib/use-action'
import { createShiftTemplateAction, setShiftTemplateActiveAction, updateShiftTemplateAction } from '../actions'
import type { ShiftTemplateView } from '../types'

/**
 * Shift templates (shifthandover.md §1): the kinds of shift the owner runs.
 *
 * A template is never deleted — the rota and the worked sessions point at it
 * — only switched off, after which nobody can be rostered onto it and
 * everything already rostered stands.
 */

const ROSTERABLE = [
  'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'INVENTORY_MANAGER', 'STOCK_KEEPER',
  'WAREHOUSE_STAFF', 'PURCHASING_MANAGER', 'ACCOUNTANT', 'ADMIN', 'OWNER',
] as const
type RosterRole = (typeof ROSTERABLE)[number]

export function TemplatesManager({
  templates,
  branches,
  canManage,
}: {
  templates: ShiftTemplateView[]
  branches: Array<{ id: string; name: string }>
  canManage: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = React.useState<ShiftTemplateView | 'new' | null>(null)
  const [toggling, setToggling] = React.useState<string | null>(null)

  const toggle = async (row: ShiftTemplateView) => {
    setToggling(row.id)
    const result = await callAction(() => setShiftTemplateActiveAction({ templateId: row.id, isActive: !row.isActive }))
    setToggling(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(result.data.isActive ? `${row.name} is back in use.` : `${row.name} retired — nobody new can be rostered onto it.`)
    router.refresh()
  }

  return (
    <SectionCard
      title="Shift templates"
      description="Day, Night, Morning — or anything you run. Times are on your own clock; a shift that ends at or before it starts runs into the next day."
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> New shift
          </Button>
        ) : null
      }
    >
      {templates.length === 0 ? (
        <EmptyState
          title="No shifts defined yet"
          description={canManage ? 'Add a Day or Night shift to start rostering people.' : 'The owner has not defined any shifts yet.'}
        />
      ) : (
        <ul className="divide-y rounded-lg border text-sm" data-testid="shift-templates">
          {templates.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {row.name}
                  {!row.isActive ? <Badge variant="secondary" size="sm" className="ml-2">Retired</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {row.startTime}–{row.endTime}{row.overnight ? ' (next day)' : ''} · {row.branchName ?? 'Every location'} ·{' '}
                  {row.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}
                </p>
              </div>
              {canManage ? (
                <>
                  <Switch
                    checked={row.isActive}
                    disabled={toggling === row.id}
                    onCheckedChange={() => toggle(row)}
                    aria-label={`${row.name} in use`}
                  />
                  <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)}>
                    <Pencil />
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <TemplateDialog
        template={editing}
        branches={branches}
        onClose={() => setEditing(null)}
      />
    </SectionCard>
  )
}

function TemplateDialog({
  template,
  branches,
  onClose,
}: {
  template: ShiftTemplateView | 'new' | null
  branches: Array<{ id: string; name: string }>
  onClose: () => void
}) {
  const router = useRouter()
  const editing = template && template !== 'new' ? template : null
  const [name, setName] = React.useState('')
  const [startTime, setStartTime] = React.useState('08:00')
  const [endTime, setEndTime] = React.useState('16:00')
  const [roles, setRoles] = React.useState<RosterRole[]>([])
  const [branchId, setBranchId] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!template) return
    setName(editing?.name ?? '')
    setStartTime(editing?.startTime ?? '08:00')
    setEndTime(editing?.endTime ?? '16:00')
    setRoles((editing?.roles as RosterRole[] | undefined) ?? ['CASHIER', 'WAITER', 'KITCHEN'])
    setBranchId(editing?.branchId ?? '')
  }, [template, editing])

  const overnight = endTime <= startTime
  const valid = name.trim().length >= 2 && /^\d{2}:\d{2}$/.test(startTime) && /^\d{2}:\d{2}$/.test(endTime) && roles.length > 0

  const save = async () => {
    if (!valid) return
    setBusy(true)
    const payload = { name: name.trim(), startTime, endTime, roles, branchId }
    const result = await callAction(() =>
      editing
        ? updateShiftTemplateAction({ templateId: editing.id, ...payload })
        : createShiftTemplateAction(payload),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(result.message ?? 'Saved.')
    onClose()
    router.refresh()
  }

  return (
    <Dialog open={template !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : 'New shift'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Changing the times affects what is rostered from now on. Nothing already on the rota moves.'
              : 'Give it a name, the hours, and who may be rostered onto it.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">Name</Label>
            <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder="e.g. Day, Night, Weekend brunch" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-start">Starts</Label>
              <Input id="tpl-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-end">Ends</Label>
              <Input id="tpl-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              {overnight ? <p className="text-xs text-muted-foreground">Ends the next day.</p> : null}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-branch">Location</Label>
            <select
              id="tpl-branch"
              className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">Every location</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Who works it</Label>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {ROSTERABLE.map((role) => {
                const checked = roles.includes(role)
                return (
                  <label key={role} className="flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-sm">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) =>
                        setRoles((current) => (next === true ? [...current, role] : current.filter((r) => r !== role)))
                      }
                    />
                    {ROLE_LABELS[role] ?? role}
                  </label>
                )
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !valid} loading={busy} onClick={save}>
            {editing ? 'Save changes' : 'Add shift'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
